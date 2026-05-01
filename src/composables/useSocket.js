import { ref, onUnmounted } from 'vue'
import { io } from 'socket.io-client'
import { useAuthStore } from '@/stores/auth'

// Wraps socket.io-client with a reactive `connected` ref so views
// can show a "Reconnecting…" banner when the socket drops. The
// raw socket is still returned so callers can .on/.emit as before;
// the connection state is exposed as a `.connected` property.
export function useSocket({ spectator = false } = {}) {
  const auth = useAuthStore()
  const socket = io({ auth: { token: spectator ? 'spectator' : (auth.token || 'spectator') } })

  // Reactive connection state. Starts true assuming a fast
  // initial handshake; flips to false only after a real drop so
  // the banner doesn't flash at page load.
  // Named `isConnected` to avoid clobbering socket.io's built-in
  // `socket.connected` boolean primitive.
  const isConnected = ref(true)
  socket.on('connect',       () => { isConnected.value = true })
  socket.on('disconnect',    () => { isConnected.value = false })
  socket.on('connect_error', () => { isConnected.value = false })

  socket.isConnected = isConnected

  onUnmounted(() => socket.disconnect())
  return socket
}
