export function parentOf(path) {
    const index = path.lastIndexOf("/");
    return index === -1 ? "" : path.slice(0, index);
}
