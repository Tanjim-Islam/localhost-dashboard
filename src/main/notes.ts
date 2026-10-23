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

// Read-only migration source. New notes belong to projects; retain this file as a backup.
export function getAllNotes(): Record<string, string> {
  return notesStore.get('notes');
}

