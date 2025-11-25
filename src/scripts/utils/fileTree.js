export function buildTree(files) {
    const root = { type: 'dir', name: '<root>', path: '/', children: [] }
    const dirMap = { '/': root }


    function ensureDir(dirPath) {
        if (dirMap[dirPath]) return dirMap[dirPath]
        const segs = dirPath.split('/').filter(Boolean)
        let cur = root
        let acc = ''
        for (const s of segs) {
            acc += '/' + s
            if (!dirMap[acc]) {
                const node = { type: 'dir', name: s, path: acc + '/', children: [] }
                cur.children.push(node)
                dirMap[acc] = node
                cur = node
            } else cur = dirMap[acc]
        }
        return dirMap[dirPath]
    }


    for (const f of files) {
        const parts = f.path.split('/')
        const fileName = parts.pop()
        const dirPath = '/' + parts.filter(Boolean).join('/')
        const parent = ensureDir(dirPath)
        parent.children.push({ type: 'file', name: fileName, path: f.path, size: f.size ?? 0, text: f.text ?? '', blob: f.blob ?? null })
    }


    function sortDir(node) {
        if (node.type !== 'dir') return
        node.children.sort((a, b) => {
            if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
            return a.name.localeCompare(b.name)
        })
        node.children.forEach(sortDir)
    }
    sortDir(root)
    return root
}


export function flattenFiles(node, list = []) {
    if (node.type === 'file') list.push(node)
    else node.children.forEach(c => flattenFiles(c, list))
    return list
}