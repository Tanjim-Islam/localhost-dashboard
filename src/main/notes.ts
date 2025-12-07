import Store from 'electron-store';

export type PortNotes = {
  notes: Record<string, string>; // port number as string -> note text
};

export const notesStore = new Store<PortNotes>({
  name: 'port-notes',
  fileExtension: 'json',
  defaults: {
    notes: {},
  },
});

export function getNote(port: number | string): string {
  const key = String(port);
  return notesStore.get('notes')[key] || '';
}

export function setNote(port: number | string, note: string): void {
  const key = String(port);
  const notes = { ...notesStore.get('notes') };
  if (note.trim()) {
    notes[key] = note.trim();
  } else {
    delete notes[key];
  }
  notesStore.set('notes', notes);
}

export function getAllNotes(): Record<string, string> {
  return notesStore.get('notes');
}

