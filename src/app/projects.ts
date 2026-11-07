import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { AudioEngine } from './audio/audio-engine';
import {
  FIRST_PROJECT,
  PROJECTS,
  copyTakes,
  currentProject,
  deleteProjectTakes,
  getTake,
  purgeTakes,
  putTake,
  run,
  setCurrentProject,
} from './audio/takes-store';
import { type BundleAudio, bundleName, decodeBundle, encodeBundle } from './core/bundle';
import { type Patch, emptyPatch, parsePatch } from './core/patch';
import { UndoHistory } from './history';
import { PatchStore } from './patch-store';
import { Transport, type Song } from './transport';

/** What the project list shows. */
export interface ProjectInfo {
  id: string;
  name: string;
  created: number;
  updated: number;
}

/** A saved project: the patch, the song and (stored apart, by take id) its recorded audio. */
interface ProjectRecord extends ProjectInfo {
  patch: Patch;
  song: Song;
}

/** How long the patch and song sit unchanged before they autosave. */
const AUTOSAVE_MS = 1500;
const NAME_MAX = 40;
/** What a song file (FILE → Export song) says it is. */
const SONG_FORMAT = 'klinke-song';

const newId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const cleanName = (name: string, fallback = 'UNTITLED') =>
  name.trim().slice(0, NAME_MAX) || fallback;

/** Downloads bytes or text as a file. */
export function download(data: BlobPart, name: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/**
 * Projects: each is a patch, a song and its recorded takes, kept in IndexedDB. The open one also
 * lives in localStorage (so the app starts on it straight away) and autosaves as it changes.
 * Opening a project swaps the patch and song in place. Projects travel between browsers as
 * `.klinke` bundles (`core/bundle.ts`), songs on their own as JSON.
 */
@Injectable({ providedIn: 'root' })
export class Projects {
  private readonly store = inject(PatchStore);
  private readonly transport = inject(Transport);
  private readonly engine = inject(AudioEngine);
  private readonly history = inject(UndoHistory);

  readonly list = signal<ProjectInfo[]>([]);
  readonly current = signal(currentProject());
  readonly currentName = computed(
    () => this.list().find((p) => p.id === this.current())?.name ?? 'MY PROJECT',
  );
  /** False when the browser won't give us IndexedDB (some private modes). */
  readonly available = signal(true);
  /** Busy opening, importing or exporting (the list's buttons wait). */
  readonly busy = signal(false);

  private autosave?: ReturnType<typeof setTimeout>;
  private writing = Promise.resolve();

  constructor() {
    // Every save (SAVE, Ctrl+S, autosave) writes the open project.
    let first = true;
    effect(() => {
      this.store.saves();
      if (first) {
        first = false;
        return;
      }
      untracked(() => void this.writeCurrent());
    });
    // Autosave a moment after the patch or song stops changing.
    let start = true;
    effect(() => {
      this.store.patch();
      this.transport.song();
      if (start) {
        start = false;
        return;
      }
      clearTimeout(this.autosave);
      this.autosave = setTimeout(() => this.store.save(true), AUTOSAVE_MS);
    });
    void this.init();
  }

  // ── Library ───────────────────────────────────────────

  /**
   * Loads the list. The first time, what's in the browser from before projects existed becomes
   * the first project (its takes were moved into it when the database upgraded).
   */
  private async init() {
    try {
      await this.refresh();
      if (!this.list().some((p) => p.id === this.current())) {
        const name = this.current() === FIRST_PROJECT ? 'MY PROJECT' : 'RECOVERED PROJECT';
        await this.put(this.recordNow(name, Date.now()));
        await this.refresh();
      }
      await this.purge();
    } catch {
      this.available.set(false);
    }
  }

  private async refresh() {
    const all = await run<ProjectRecord[]>(PROJECTS, 'readonly', (s) => s.getAll());
    this.list.set(
      all
        .map(({ id, name, created, updated }) => ({ id, name, created, updated }))
        .sort((a, b) => b.updated - a.updated),
    );
  }

  private get(id: string) {
    return run<ProjectRecord | undefined>(PROJECTS, 'readonly', (s) => s.get(id));
  }

  private put(rec: ProjectRecord) {
    return run(PROJECTS, 'readwrite', (s) => s.put(rec));
  }

  /** The open project as it stands. */
  private recordNow(name = this.currentName(), created?: number): ProjectRecord {
    const info = this.list().find((p) => p.id === this.current());
    return {
      id: this.current(),
      name,
      created: created ?? info?.created ?? Date.now(),
      updated: Date.now(),
      patch: this.store.patch(),
      song: this.transport.song(),
    };
  }

  /** Writes the open project to IndexedDB (writes queue, so a slow one can't land after a newer one). */
  private writeCurrent(): Promise<void> {
    if (!this.available()) return Promise.resolve();
    const rec = this.recordNow();
    this.writing = this.writing
      .then(() => this.put(rec))
      .then(() => {
        this.list.update((l) => {
          const info = { id: rec.id, name: rec.name, created: rec.created, updated: rec.updated };
          const rest = l.filter((p) => p.id !== rec.id);
          return [info, ...rest];
        });
      })
      .catch(() =>
        this.store.flash("couldn't save the project: browser storage is full or blocked"),
      );
    return this.writing;
  }

  /** Saves now (and waits for it), e.g. before leaving the project. */
  async flush() {
    clearTimeout(this.autosave);
    this.store.save(true);
    await this.writeCurrent();
  }

  /** Drops the open project's audio that nothing in its song (or undo) can reach any more. */
  private async purge() {
    const used = new Set(this.transport.tracks().flatMap((t) => t.takes.map((k) => k.id)));
    await purgeTakes(this.current(), used).catch(() => undefined);
  }

  // ── Project list actions ──────────────────────────────

  async open(id: string) {
    if (id === this.current() || this.busy()) return;
    await this.work(async () => {
      const rec = await this.get(id);
      if (!rec) return this.store.flash('that project has gone');
      await this.leave();
      this.show(rec);
    });
  }

  async create() {
    await this.work(async () => {
      await this.leave();
      const now = Date.now();
      const rec: ProjectRecord = {
        id: newId(),
        name: this.nextName('NEW PROJECT'),
        created: now,
        updated: now,
        patch: emptyPatch(),
        song: this.transport.newSong(),
      };
      await this.put(rec);
      this.show(rec);
    });
  }

  async rename(id: string, name: string) {
    const rec = id === this.current() ? this.recordNow() : await this.get(id);
    if (!rec) return;
    const clean = cleanName(name, rec.name);
    if (clean === rec.name) return;
    // Renaming the open project updates the list first, so its next save keeps the new name.
    this.list.update((l) => l.map((p) => (p.id === id ? { ...p, name: clean } : p)));
    await this.put({ ...rec, name: clean }).catch(() => undefined);
    await this.refresh();
  }

  async duplicate(id: string) {
    await this.work(async () => {
      if (id === this.current()) await this.flush();
      const rec = await this.get(id);
      if (!rec) return;
      const now = Date.now();
      const copy = {
        ...rec,
        id: newId(),
        name: this.nextName(`${rec.name} COPY`),
        created: now,
        updated: now,
      };
      await copyTakes(id, copy.id);
      await this.put(copy);
      await this.refresh();
      this.store.flash(`duplicated as ${copy.name}`);
    });
  }

  /** Deletes a project and its audio; deleting the open one opens the next (or a new one). */
  async remove(id: string) {
    await this.work(async () => {
      if (id === this.current()) {
        const next = this.list().find((p) => p.id !== id);
        const rec = next && (await this.get(next.id));
        await this.leave(false);
        if (rec) this.show(rec);
        else {
          const now = Date.now();
          const fresh: ProjectRecord = {
            id: newId(),
            name: 'NEW PROJECT',
            created: now,
            updated: now,
            patch: emptyPatch(),
            song: this.transport.newSong(),
          };
          await this.put(fresh);
          this.show(fresh);
        }
      }
      await run(PROJECTS, 'readwrite', (s) => s.delete(id));
      await deleteProjectTakes(id).catch(() => undefined);
      await this.refresh();
    });
  }

  // ── Files ─────────────────────────────────────────────

  /** FILE → Export project: the patch, the song and every take, as one `.klinke` file. */
  async exportBundle() {
    await this.work(async () => {
      await this.flush();
      const rec = this.recordNow();
      const audio = new Map<string, BundleAudio>();
      for (const t of rec.song.tracks)
        for (const k of t.takes) {
          const a = await getTake(k.id).catch(() => undefined);
          if (a) audio.set(k.id, a);
        }
      const project = {
        format: 'klinke-project',
        name: rec.name,
        patch: rec.patch,
        song: rec.song,
      };
      download(encodeBundle({ project, audio }), bundleName(rec.name), 'application/octet-stream');
    });
  }

  /** FILE → Import project: a `.klinke` file becomes a new project, opened. */
  async importBundle(file: File) {
    await this.work(async () => {
      const bundle = decodeBundle(new Uint8Array(await file.arrayBuffer()));
      const p = bundle?.project as { name?: unknown; patch?: unknown; song?: unknown } | undefined;
      const patch = p && parsePatch(JSON.stringify(p.patch));
      const song = p && this.transport.parseSong(p.song);
      if (!bundle || !patch || !song) return this.store.flash("that file isn't a KLINKE project");
      const now = Date.now();
      const base =
        typeof p.name === 'string' ? cleanName(p.name) : file.name.replace(/\.klinke$/i, '');
      const rec: ProjectRecord = {
        id: newId(),
        name: this.nextName(cleanName(base)),
        created: now,
        updated: now,
        patch,
        song,
      };
      const used = new Set(song.tracks.flatMap((t) => t.takes.map((k) => k.id)));
      for (const [id, a] of bundle.audio) if (used.has(id)) await putTake(id, a, rec.id);
      await this.leave();
      await this.put(rec);
      this.show(rec);
    });
  }

  /** FILE → Export song: the tempo, loop and tracks with their notes, as JSON (no audio). */
  exportSong() {
    const song = this.transport.song();
    const tracks = song.tracks.map((t) => ({ ...t, takes: [] }));
    const json = JSON.stringify({ format: SONG_FORMAT, ...song, tracks }, null, 2);
    download(json, 'klinke-song.json', 'application/json');
  }

  /** FILE → Import song: replaces the song (tracks, notes, tempo, loop); undo brings it back. */
  importSong(json: string): boolean {
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch {
      raw = undefined;
    }
    const song = this.transport.parseSong(raw);
    if (!song || (raw as { format?: unknown }).format !== SONG_FORMAT) {
      this.store.flash("that file isn't a KLINKE song");
      return false;
    }
    this.transport.applySong({ ...song, tracks: song.tracks.map((t) => ({ ...t, takes: [] })) });
    return true;
  }

  // ── Switching ─────────────────────────────────────────

  private async work(job: () => Promise<unknown>) {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await job();
    } catch {
      this.store.flash("couldn't do that: browser storage is full or blocked");
    } finally {
      this.busy.set(false);
    }
  }

  /** Stops everything and saves the open project before another takes its place. */
  private async leave(save = true) {
    const wasRecording = this.transport.recording();
    this.transport.stop();
    this.engine.kill();
    // A take being recorded finishes (and stores its audio) after REC stops.
    if (wasRecording) await new Promise((r) => setTimeout(r, 500));
    if (save) await this.flush();
  }

  /** Puts a project on the floor and the timeline. */
  private show(rec: ProjectRecord) {
    clearTimeout(this.autosave);
    setCurrentProject(rec.id);
    this.current.set(rec.id);
    this.store.open(parsePatch(JSON.stringify(rec.patch)) ?? emptyPatch());
    this.transport.applySong(this.transport.parseSong(rec.song) ?? this.transport.newSong());
    this.transport.openTrack.set(null);
    this.transport.seek(0);
    this.history.clear();
    if (!this.list().some((p) => p.id === rec.id))
      this.list.update((l) => [
        { id: rec.id, name: rec.name, created: rec.created, updated: rec.updated },
        ...l,
      ]);
    this.store.save(true);
    this.store.flash(`opened ${rec.name}`);
    void this.purge();
  }

  /** A name not already in the list: NAME, NAME 2, NAME 3… */
  private nextName(name: string): string {
    const taken = new Set(this.list().map((p) => p.name));
    if (!taken.has(name)) return name;
    for (let i = 2; ; i++) if (!taken.has(`${name} ${i}`)) return `${name} ${i}`;
  }
}
