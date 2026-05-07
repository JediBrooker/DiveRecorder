import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const routes = [
  {
    path: '/',
    component: () => import('@/views/HomeView.vue'),
    meta: { guestOnly: true },
  },
  {
    path: '/login',
    component: () => import('@/views/LoginView.vue'),
    meta: { guestOnly: true },
  },
  {
    path: '/register',
    component: () => import('@/views/RegisterView.vue'),
  },
  {
    path: '/register-org',
    component: () => import('@/views/RegisterOrgView.vue'),
  },
  {
    path: '/forgot-password',
    component: () => import('@/views/ForgotPasswordView.vue'),
  },
  {
    path: '/reset-password',
    component: () => import('@/views/ResetPasswordView.vue'),
  },
  {
    path: '/dashboard',
    component: () => import('@/views/DashboardView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/manager',
    component: () => import('@/views/ManagerView.vue'),
    meta: { requiresAuth: true, requiresRole: ['org_admin', 'meet_manager'] },
  },
  {
    path: '/competitor',
    component: () => import('@/views/CompetitorView.vue'),
    meta: { requiresAuth: true, requiresRole: ['diver'] },
  },
  {
    path: '/coach',
    component: () => import('@/views/CoachView.vue'),
    meta: { requiresAuth: true, requiresRole: ['coach'] },
  },
  {
    path: '/control',
    component: () => import('@/views/ControlView.vue'),
    meta: { requiresAuth: true, requiresRole: ['org_admin', 'meet_manager', 'referee'] },
  },
  {
    path: '/judge',
    component: () => import('@/views/JudgeView.vue'),
    meta: { requiresAuth: true, requiresRole: ['judge'] },
  },
  {
    // Unified live + archive surface — the old /archive route
    // was retired once this view absorbed both browse-completed-
    // meets and live-broadcast modes.
    //
    // /scoreboard            → list mode (browse meets)
    // /scoreboard/:eventId   → detail mode (deep-link to one meet)
    // /scoreboard/:eventId/broadcast → projector / kiosk mode
    path: '/scoreboard/:eventId?/:mode?',
    component: () => import('@/views/ScoreboardView.vue'),
  },
  {
    // Public meet landing page — meet metadata + every event
    // grouped by status. Each event card jumps into /scoreboard.
    path: '/meet/:id',
    component: () => import('@/views/MeetView.vue'),
  },
  {
    path: '/users',
    component: () => import('@/views/UserManagerView.vue'),
    meta: { requiresAuth: true, requiresRole: ['org_admin'] },
  },
  {
    path: '/clubs',
    component: () => import('@/views/ClubsView.vue'),
    meta: { requiresAuth: true, requiresRole: ['org_admin', 'meet_manager'] },
  },
  {
    path: '/teams',
    component: () => import('@/views/TeamsView.vue'),
    meta: { requiresAuth: true, requiresRole: ['org_admin', 'meet_manager'] },
  },
  {
    path: '/teams/:teamId/events/:eventId/dive-list',
    component: () => import('@/views/TeamDiveListView.vue'),
    meta: { requiresAuth: true, requiresRole: ['org_admin', 'meet_manager'] },
  },
  {
    path: '/assign-judges',
    component: () => import('@/views/AssignJudgesView.vue'),
    meta: { requiresAuth: true, requiresRole: ['org_admin', 'meet_manager'] },
  },
  {
    // /profile/:id is a PUBLIC profile page — anonymous spectators
    // landing here from a scoreboard diver-link should see the
    // diver's competitive history without being bounced to /login.
    // /profile (no id) means "my profile" and still needs a session;
    // the guard below redirects in that case.
    path: '/profile/:id?',
    component: () => import('@/views/DiverProfileView.vue'),
    meta: { requiresAuthIfNoId: true },
  },
  {
    // Side-by-side diver comparison. Diver IDs in the query string
    // (?a=&b=) so the URL is shareable like the rest of the app.
    path: '/compare',
    component: () => import('@/views/CompareView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/events/:id/audit',
    component: () => import('@/views/ScoreAuditView.vue'),
    meta: { requiresAuth: true, requiresRole: ['org_admin', 'meet_manager'] },
  },
  {
    // Dive Directory browser: read the World Aquatics catalog,
    // add custom rows for poolside / progression dives. Anyone
    // signed in can browse; the create/edit/delete affordances
    // gate themselves on row.is_custom + same-org membership.
    path: '/dive-directory',
    component: () => import('@/views/DiveDirectoryView.vue'),
    meta: { requiresAuth: true },
  },
  {
    // Cut 3 referee sign-off — the page where a referee types
    // the 6-digit handoff code the meet manager generated on
    // their device.
    path: '/sign-off-codes',
    component: () => import('@/views/SignOffCodeView.vue'),
    meta: { requiresAuth: true, requiresRole: ['referee', 'org_admin'] },
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

// The guard is called after app.use(createPinia()) so the store is safe to access here.
// We call useAuthStore() inside the guard (not at module scope) so Pinia is active.
router.beforeEach((to, from, next) => {
  const auth = useAuthStore()
  const isLoggedIn = auth.isLoggedIn

  // Redirect logged-in users away from guest-only pages
  if (to.meta.guestOnly && isLoggedIn) {
    return next('/dashboard')
  }

  // Require auth
  if (to.meta.requiresAuth && !isLoggedIn) {
    return next('/login')
  }

  // Public-with-id, owner-private without: /profile/:id is open to
  // anonymous viewers, but /profile (no id) means the viewer's own
  // profile and so needs a session.
  if (to.meta.requiresAuthIfNoId && !isLoggedIn && !to.params.id) {
    return next('/login')
  }

  // Require specific roles
  if (to.meta.requiresRole && isLoggedIn) {
    if (!auth.hasAnyRole(to.meta.requiresRole)) {
      return next('/dashboard')
    }
  }

  next()
})

export default router
