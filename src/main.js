import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')

// Register the service worker only in production builds — the
// Vite dev server's HMR conflicts with cached assets. Skips
// silently in older Safari / in-app webviews that don't support
// service workers.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js').catch(() => {
    // Non-fatal — the app still works without offline support.
  })
}
