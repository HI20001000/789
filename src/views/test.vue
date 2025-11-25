<template>
  <div class="app" :style="{ '--sidebar-w': sidebarW + 'px' }">
    <!-- Top Bar -->
    <header class="topbar">
      <div class="left">
        <button class="icon" title="Toggle Sidebar" @click="toggleSidebar">{{ sidebarCollapsed ? '☰' : '🟦' }}</button>
        <h1 class="title">VibeCoding — Projects</h1>
      </div>
      <div class="right">
        <div class="search">
          <input
            ref="searchRef"
            v-model.trim="q"
            type="search"
            placeholder="Search (Ctrl+K)"
          />
          <button class="icon" v-if="q" @click="q = ''" title="Clear">✕</button>
        </div>
        <button class="btn" @click="openPalette">⌘⇧P Command Palette</button>
        <button class="btn primary" @click="newProject">＋ New Project</button>
      </div>
    </header>

    <div class="body">
      <!-- Sidebar -->
      <aside class="sidebar" :class="{ collapsed: sidebarCollapsed }">
        <section>
          <h3 @click="toggle('workspaces')">Workspaces <span>{{ workspaces.length }}</span></h3>
          <ul v-show="sections.workspaces">
            <li
              v-for="ws in workspaces"
              :key="ws.id"
              :class="{ active: activeWorkspaceId === ws.id }"
              @click="activeWorkspaceId = ws.id"
            >
              <span class="dot" :style="{ background: ws.color }"></span>
              <span class="name">{{ ws.name }}</span>
            </li>
          </ul>
        </section>
        <section>
          <h3 @click="toggle('tags')">Tags <span>{{ tags.length }}</span></h3>
          <div class="taglist" v-show="sections.tags">
            <button
              v-for="t in tags"
              :key="t"
              class="tag"
              :class="{ active: activeTag === t }"
              @click="activeTag = activeTag === t ? '' : t"
            >
              #{{ t }}
            </button>
          </div>
        </section>
        <section>
          <h3 @click="toggle('recents')">Recents <span>{{ recentProjects.length }}</span></h3>
          <ul v-show="sections.recents">
            <li v-for="p in recentProjects.slice(0, 8)" :key="p.id" @click="openProject(p)">
              <span class="file">🗂</span>
              <div class="meta">
                <div class="name">{{ p.name }}</div>
                <div class="path">{{ p.path }}</div>
              </div>
            </li>
          </ul>
        </section>
      </aside>

      <!-- Resizer -->
      <div class="resizer" @mousedown="startResize" />

      <!-- Main -->
      <main class="main">
        <div class="toolbar">
          <div class="left">
            <button class="viewbtn" :class="{ on: view === 'grid' }" @click="view = 'grid'" title="Grid">▦</button>
            <button class="viewbtn" :class="{ on: view === 'list' }" @click="view = 'list'" title="List">≣</button>
            <div class="divider" />
            <label class="select">
              Sort
              <select v-model="sortBy">
                <option value="updatedAt">Recently Used</option>
                <option value="name">Name</option>
                <option value="createdAt">Date Created</option>
              </select>
            </label>
            <label class="select">
              Filter
              <select v-model="activeTag">
                <option value="">All Tags</option>
                <option v-for="t in tags" :key="t" :value="t">#{{ t }}</option>
              </select>
            </label>
          </div>
          <div class="right">
            <button class="btn ghost" @click="importProjects">Import…</button>
            <button class="btn ghost" @click="openFolder">Open Folder…</button>
            <button class="btn ghost" @click="settings">Settings</button>
          </div>
        </div>

        <!-- Empty state -->
        <div v-if="filtered.length === 0" class="empty">
          <div class="empty-card">
            <div class="emoji">📁</div>
            <h2>No projects match your filters</h2>
            <p>Try clearing the search or tag filter, or create a new project.</p>
            <div class="actions">
              <button class="btn primary" @click="newProject">＋ New Project</button>
              <button class="btn" @click="q = ''; activeTag = ''">Clear Filters</button>
            </div>
          </div>
        </div>

        <!-- Project list/grid -->
        <div v-else :class="['projects', view]">
          <article
            v-for="p in filtered"
            :key="p.id"
            :class="['card', { pinned: p.pinned }]"
            @dblclick="openProject(p)"
          >
            <div class="card-head">
              <div class="left">
                <div class="avatar" :style="{ background: colorFor(p.name) }">{{ initials(p.name) }}</div>
                <div class="titles">
                  <h4 class="name" :title="p.name">{{ p.name }}</h4>
                  <div class="path" :title="p.path">{{ p.path }}</div>
                </div>
              </div>
              <div class="right">
                <button class="icon" :title="p.pinned ? 'Unpin' : 'Pin'" @click.stop="togglePin(p)">📌</button>
                <button class="icon" title="More" @click.stop="p.menuOpen = !p.menuOpen">⋯</button>
              </div>
            </div>

            <div class="card-tags">
              <span class="tag" v-for="t in p.tags" :key="t" @click.stop="activeTag = t">#{{ t }}</span>
            </div>

            <div class="card-meta">
              <span>Last used: {{ timeago(p.updatedAt) }}</span>
              <span>Created: {{ prettyDate(p.createdAt) }}</span>
            </div>

            <div class="card-actions">
              <button class="btn" @click.stop="openProject(p)">Open</button>
              <button class="btn" @click.stop="openTerminal(p)">Terminal</button>
              <button class="btn ghost" @click.stop="reveal(p)">Reveal</button>
              <button class="btn danger ghost" @click.stop="removeProject(p)">Remove</button>
            </div>

            <div v-if="p.menuOpen" class="menu" @click.stop>
              <button @click="renameProject(p)">Rename…</button>
              <button @click="duplicateProject(p)">Duplicate</button>
              <button @click="editTags(p)">Edit Tags…</button>
            </div>
          </article>
        </div>
      </main>
    </div>

    <!-- Status Bar -->
    <footer class="statusbar">
      <div class="left">
        <span>Projects: {{ projects.length }}</span>
        <span>Filtered: {{ filtered.length }}</span>
      </div>
      <div class="right">
        <span>Vite + Vue 3</span>
      </div>
    </footer>

    <!-- Command Palette -->
    <div v-if="palette.open" class="palette" @click.self="palette.open = false">
      <div class="palette-box">
        <input
          ref="paletteRef"
          v-model="palette.query"
          type="text"
          placeholder="Type a command…"
          @keydown.esc.prevent="palette.open = false"
        />
        <ul>
          <li v-for="(cmd, i) in paletteFiltered" :key="cmd.id" :class="{ active: i === palette.cursor }" @click="runCommand(cmd)">
            <span class="k">{{ cmd.k }}</span>
            <span class="t">{{ cmd.t }}</span>
          </li>
        </ul>
        <div class="hint">Press Esc to close • Enter to run</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'

// ————— State —————
const q = ref('')
const view = ref('grid') // 'grid' | 'list'
const sortBy = ref('updatedAt')
const activeTag = ref('')
const activeWorkspaceId = ref('default')
const sections = reactive({ workspaces: true, tags: true, recents: true })
const sidebarCollapsed = ref(false)
const sidebarW = ref(280)
const searchRef = ref(null)
const paletteRef = ref(null)

const workspaces = reactive([
  { id: 'default', name: 'Default', color: '#60a5fa' },
  { id: 'school', name: 'School', color: '#34d399' },
  { id: 'client', name: 'Client', color: '#fbbf24' },
])

const projects = ref(loadProjects())

// Derived lists
const tags = computed(() => Array.from(new Set(projects.value.flatMap(p => p.tags))).sort())
const recentProjects = computed(() => [...projects.value].sort((a,b) => b.updatedAt - a.updatedAt))

// Filter + sort
const filtered = computed(() => {
  let arr = projects.value.filter(p => p.workspaceId === activeWorkspaceId.value)
  if (q.value) {
    const qq = q.value.toLowerCase()
    arr = arr.filter(p =>
      p.name.toLowerCase().includes(qq) ||
      p.path.toLowerCase().includes(qq) ||
      p.tags.some(t => t.toLowerCase().includes(qq))
    )
  }
  if (activeTag.value) arr = arr.filter(p => p.tags.includes(activeTag.value))
  switch (sortBy.value) {
    case 'name': arr.sort((a,b) => a.name.localeCompare(b.name)); break
    case 'createdAt': arr.sort((a,b) => b.createdAt - a.createdAt); break
    default: arr.sort((a,b) => b.updatedAt - a.updatedAt)
  }
  // Pinned first
  arr.sort((a,b) => Number(b.pinned) - Number(a.pinned))
  return arr
})

// ————— Command Palette —————
const palette = reactive({ open: false, query: '', cursor: 0 })
const commands = computed(() => ([
  { id: 'new', k: '⌘N', t: 'New Project', run: newProject },
  { id: 'open', k: '⌘O', t: 'Open Folder…', run: openFolder },
  { id: 'import', k: '⇧I', t: 'Import Projects…', run: importProjects },
  { id: 'settings', k: '⌘,', t: 'Settings', run: settings },
  { id: 'toggleSidebar', k: '⌘B', t: 'Toggle Sidebar', run: toggleSidebar },
  { id: 'focusSearch', k: '⌘K', t: 'Focus Search', run: () => searchRef.value?.focus() },
]))
const paletteFiltered = computed(() => {
  const qq = palette.query.trim().toLowerCase()
  return qq ? commands.value.filter(c => c.t.toLowerCase().includes(qq)) : commands.value
})

function openPalette(){
  palette.open = true
  palette.query = ''
  palette.cursor = 0
  nextTick(() => paletteRef.value?.focus())
}
function runCommand(cmd){
  palette.open = false
  cmd.run?.()
}

// ————— Actions —————
function newProject(){
  const base = prompt('Project name?') || 'New Project'
  const now = Date.now()
  const p = {
    id: 'p_' + now,
    name: base,
    path: `D:/projects/${slugify(base)}`,
    createdAt: now,
    updatedAt: now,
    tags: [],
    pinned: false,
    workspaceId: activeWorkspaceId.value,
    menuOpen: false,
  }
  projects.value.unshift(p)
}
function openFolder(){
  alert('Open Folder: (placeholder) hook your OS dialog here')
}
function importProjects(){
  alert('Import: (placeholder) parse a JSON or scan directories')
}
function settings(){
  alert('Settings: (placeholder) open settings page/modal')
}
function openProject(p){
  p.updatedAt = Date.now()
  alert('Open project: ' + p.name)
}
function openTerminal(p){
  alert('Open terminal at: ' + p.path)
}
function reveal(p){
  alert('Reveal in file explorer: ' + p.path)
}
function renameProject(p){
  const nn = prompt('Rename project', p.name)
  if (nn && nn !== p.name){ p.name = nn }
}
function duplicateProject(p){
  const now = Date.now()
  const copy = { ...p, id: 'p_' + now, name: p.name + ' Copy', createdAt: now, updatedAt: now, pinned: false, menuOpen: false }
  projects.value.unshift(copy)
}
function editTags(p){
  const input = prompt('Comma separated tags', p.tags.join(','))
  if (input !== null){ p.tags = input.split(',').map(s => s.trim()).filter(Boolean) }
}
function removeProject(p){
  if (confirm(`Remove \"${p.name}\" from list? (won\'t delete files)`)){
    projects.value = projects.value.filter(x => x.id !== p.id)
  }
}
function togglePin(p){ p.pinned = !p.pinned }

// ————— Sidebar collapse + resize —————
function toggleSidebar(){ sidebarCollapsed.value = !sidebarCollapsed.value }
let dragging = false
function startResize(e){
  dragging = true
  const startX = e.clientX
  const startW = sidebarW.value
  const onMove = (ev) => {
    if (!dragging) return
    const dx = ev.clientX - startX
    sidebarW.value = Math.min(480, Math.max(180, startW + dx))
  }
  const onUp = () => { dragging = false; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

// ————— Utils —————
function initials(name){ return name.split(/\s+/).map(s => s[0]).join('').slice(0,2).toUpperCase() }
function colorFor(name){
  const h = Array.from(name).reduce((a,c) => a + c.charCodeAt(0), 0) % 360
  return `hsl(${h} 70% 45%)`
}
function slugify(s){ return s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'') }
function prettyDate(ts){ const d = new Date(ts); return d.toLocaleDateString() }
function timeago(ts){
  const s = Math.floor((Date.now() - ts)/1000)
  if (s < 60) return s + 's ago'
  const m = Math.floor(s/60); if (m < 60) return m + 'm ago'
  const h = Math.floor(m/60); if (h < 24) return h + 'h ago'
  const d = Math.floor(h/24); if (d < 30) return d + 'd ago'
  const mo = Math.floor(d/30); if (mo < 12) return mo + 'mo ago'
  const y = Math.floor(mo/12); return y + 'y ago'
}

function toggle(key){ sections[key] = !sections[key] }

// ————— Keyboard —————
onMounted(() => {
  const onKey = (e) => {
    // Ctrl/Cmd+K focus search
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k'){
      e.preventDefault(); searchRef.value?.focus()
    }
    // Ctrl/Cmd+Shift+P palette
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'p'){
      e.preventDefault(); openPalette()
    }
  }
  window.addEventListener('keydown', onKey)
  cleanup.push(() => window.removeEventListener('keydown', onKey))
})

const cleanup = []
onBeforeUnmount(() => cleanup.forEach(fn => fn()))

// ————— Persistence —————
watch(projects, (val) => localStorage.setItem('vscodeLikeProjects', JSON.stringify(val)), { deep: true })

function loadProjects(){
  const raw = localStorage.getItem('vscodeLikeProjects')
  if (raw){
    try { const parsed = JSON.parse(raw); return parsed.map(p => ({ ...p, menuOpen:false })) } catch {}
  }
  const now = Date.now()
  return [
    { id:'p1', name:'Vue Playground', path:'D:/code/vue-playground', createdAt: now-1000*60*60*24*50, updatedAt: now-1000*60*10, tags:['vue','vite'], pinned:true, workspaceId:'default', menuOpen:false },
    { id:'p2', name:'SQL Review Tool', path:'D:/sql/review', createdAt: now-1000*60*60*24*100, updatedAt: now-1000*60*60*2, tags:['node','tooling'], pinned:false, workspaceId:'client', menuOpen:false },
    { id:'p3', name:'PatchTST Research', path:'D:/lab/patchtst', createdAt: now-1000*60*60*24*200, updatedAt: now-1000*60*60*24*3, tags:['python','research'], pinned:false, workspaceId:'school', menuOpen:false },
  ]
}
</script>

<style scoped>
:root { --sidebar-w: 280px; }
.app { display:flex; flex-direction:column; height:100vh; background:#0b1020; color:#d7dde8; }
.topbar { height:52px; display:flex; align-items:center; justify-content:space-between; padding:0 12px; background:#0f172a; border-bottom:1px solid #1f2937; }
.topbar .left { display:flex; align-items:center; gap:10px; }
.title { font-size:14px; font-weight:600; letter-spacing:.2px; }
.topbar .right { display:flex; gap:8px; align-items:center; }
.search { display:flex; align-items:center; background:#0b1224; border:1px solid #1f2937; border-radius:8px; padding:4px 6px; }
.search input { background:transparent; border:none; outline:none; color:#e5e7eb; width:220px; }

.btn { background:#1f2937; color:#e5e7eb; border:1px solid #374151; padding:6px 10px; border-radius:8px; font-size:12px; cursor:pointer; }
.btn:hover { filter:brightness(1.1) }
.btn.primary { background:#2563eb; border-color:#1e40af; }
.btn.ghost { background:transparent; border-color:#374151; }
.btn.danger { border-color:#dc2626; color:#fecaca; }
.icon { border:none; background:transparent; color:#cbd5e1; cursor:pointer; font-size:14px; padding:6px; }

.body { flex:1; display:flex; min-height:0; }
.sidebar { width:var(--sidebar-w); background:#0f172a; border-right:1px solid #1f2937; padding:10px; overflow:auto; transition:width .2s ease; }
.sidebar.collapsed { width:0; padding:0; border-right:none; }
.sidebar h3 { font-size:12px; text-transform:uppercase; letter-spacing:.8px; color:#94a3b8; display:flex; justify-content:space-between; margin:14px 6px 8px; cursor:pointer; }
.sidebar ul { list-style:none; padding:0; margin:0; }
.sidebar li { display:flex; align-items:center; gap:8px; padding:6px 8px; border-radius:6px; cursor:pointer; }
.sidebar li:hover { background:#111827; }
.sidebar li.active { background:#111827; outline:1px solid #1f2937; }
.sidebar .dot { width:10px; height:10px; border-radius:50%; flex:0 0 10px; }
.sidebar .name { font-size:13px; }
.sidebar .taglist { display:flex; flex-wrap:wrap; gap:6px; padding:6px; }
.sidebar .tag { background:#111827; border:1px solid #1f2937; color:#9ca3af; padding:4px 8px; border-radius:999px; cursor:pointer; font-size:12px; }
.sidebar .tag.active { color:#e5e7eb; border-color:#334155; }
.sidebar .path { color:#6b7280; font-size:11px; }
.sidebar .file { opacity:.8 }
.sidebar .meta { min-width:0 }
.sidebar .meta .name { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

.resizer { width:4px; cursor:col-resize; background:linear-gradient(90deg, transparent, #0b1224 50%, transparent); }

.main { flex:1; display:flex; flex-direction:column; min-width:0; }
.toolbar { height:46px; display:flex; align-items:center; justify-content:space-between; padding:0 12px; border-bottom:1px solid #1f2937; background:#0b1224; }
.toolbar .left { display:flex; align-items:center; gap:10px; }
.toolbar .right { display:flex; gap:8px; }
.viewbtn { background:#111827; border:1px solid #1f2937; color:#94a3b8; padding:4px 8px; border-radius:6px; cursor:pointer; }
.viewbtn.on { color:#e5e7eb; border-color:#334155; }
.select { font-size:12px; color:#9ca3af; display:flex; align-items:center; gap:6px; }
.select select { background:#0f172a; color:#e5e7eb; border:1px solid #1f2937; border-radius:6px; padding:4px 8px; }

.projects.grid { padding:14px; display:grid; grid-template-columns:repeat(auto-fill, minmax(280px, 1fr)); gap:12px; overflow:auto; }
.projects.list { padding:6px; display:flex; flex-direction:column; gap:8px; overflow:auto; }
.card { background:#0f172a; border:1px solid #1f2937; border-radius:12px; padding:10px; position:relative; }
.card.pinned { box-shadow:0 0 0 1px #334155 inset; }
.card-head { display:flex; align-items:flex-start; justify-content:space-between; gap:8px; }
.card-head .left { display:flex; gap:10px; min-width:0; }
.avatar { width:36px; height:36px; border-radius:8px; display:grid; place-items:center; font-weight:700; color:#0b1020; }
.titles { min-width:0 }
.name { font-size:14px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.path { font-size:11px; color:#94a3b8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.card-tags { margin:8px 0 6px; display:flex; gap:6px; flex-wrap:wrap; }
.card-tags .tag { font-size:11px; color:#9ca3af; background:#111827; border:1px solid #1f2937; border-radius:999px; padding:3px 6px; cursor:pointer; }
.card-meta { font-size:11px; color:#94a3b8; display:flex; gap:12px; margin-bottom:8px; }
.card-actions { display:flex; gap:8px; flex-wrap:wrap; }
.card .menu { position:absolute; top:38px; right:10px; background:#0b1224; border:1px solid #1f2937; border-radius:8px; padding:6px; display:flex; flex-direction:column; gap:2px; z-index:5; }
.card .menu button { background:transparent; border:none; color:#e5e7eb; text-align:left; padding:6px 10px; border-radius:6px; cursor:pointer; }
.card .menu button:hover { background:#111827; }

.empty { flex:1; display:grid; place-items:center; }
.empty-card { text-align:center; background:#0f172a; border:1px solid #1f2937; padding:28px; border-radius:16px; max-width:560px; }
.empty-card .emoji { font-size:36px; margin-bottom:10px; }
.empty .actions { margin-top:10px; display:flex; gap:8px; justify-content:center; }

.statusbar { height:28px; background:#0f172a; border-top:1px solid #1f2937; display:flex; align-items:center; justify-content:space-between; padding:0 10px; font-size:12px; color:#94a3b8; }
.statusbar .left, .statusbar .right { display:flex; gap:12px; align-items:center; }

/* Palette */
.palette { position:fixed; inset:0; background:rgba(0,0,0,.3); display:grid; place-items:start center; padding-top:10vh; z-index:50; backdrop-filter: blur(2px); }
.palette-box { width:720px; max-width:92vw; background:#0b1224; border:1px solid #1f2937; border-radius:12px; overflow:hidden; box-shadow:0 10px 40px rgba(0,0,0,.4); }
.palette-box input { width:100%; padding:12px 14px; background:#0f172a; color:#e5e7eb; border:none; outline:none; font-size:14px; }
.palette-box ul { max-height:40vh; overflow:auto; }
.palette-box li { display:flex; align-items:center; gap:10px; padding:10px 14px; border-top:1px solid #0f172a; cursor:pointer; }
.palette-box li.active, .palette-box li:hover { background:#0f172a; }
.palette-box .k { font-size:12px; color:#94a3b8; width:56px; }
.palette-box .t { font-size:13px; }
.palette .hint { font-size:12px; color:#94a3b8; padding:8px 12px; text-align:right; }

/* List view tweak */
.projects.list .card { display:grid; grid-template-columns: 1fr auto; gap:10px; align-items:center; }
.projects.list .card-tags { margin:0 }
.projects.list .card-actions { justify-self:end }
</style>
