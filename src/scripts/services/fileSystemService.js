export async function getFileHandleByPath(rootHandle, relPath) {
    const parts = relPath.split("/").filter(Boolean);
    if (!parts.length) throw new Error("Invalid path");
    let dir = rootHandle;
    for (let i = 0; i < parts.length - 1; i++) {
        dir = await dir.getDirectoryHandle(parts[i]);
    }
    return await dir.getFileHandle(parts[parts.length - 1]);
}

export async function getViewFolderDir() {
    if (!("storage" in navigator) || !navigator.storage.getDirectory) return null;
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle("viewFolder", { create: true });
}

export async function copyDirectorySafe(srcDirHandle, destDirHandle) {
    for await (const [name, handle] of srcDirHandle.entries()) {
        try {
            if (handle.kind === "directory") {
                const newSub = await destDirHandle.getDirectoryHandle(name, { create: true });
                await copyDirectorySafe(handle, newSub);
            } else {
                const file = await handle.getFile();
                const newFile = await destDirHandle.getFileHandle(name, { create: true });
                const writable = await newFile.createWritable();
                await writable.write(await file.arrayBuffer());
                await writable.close();
            }
        } catch (error) {
            console.warn("Skip item on copy error:", name, error);
        }
    }
}
