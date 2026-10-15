/** Links into Google Drive — safe to import anywhere (no server code). */
export function fileUrl(id: string): string { return `https://drive.google.com/file/d/${id}/view`; }
export function folderUrl(id: string): string { return `https://drive.google.com/drive/folders/${id}`; }
