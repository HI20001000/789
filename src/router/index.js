import { createRouter, createWebHistory } from 'vue-router'
import workspacePage from '@/views/workspace.vue'
import testPage from '@/views/test.vue'

const routes = [
  { path: '/', name: 'workspacePage', component: workspacePage },
  { path: '/abc', name: 'testPage', component: testPage }
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

export default router
