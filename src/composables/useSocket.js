import { onUnmounted } from 'vue'
import { io } from 'socket.io-client'
import { useAuthStore } from '@/stores/auth'

export function useSocket({ spectator = false } = {}) {
  const auth = useAuthStore()
  const socket = io({ auth: { token: spectator ? 'spectator' : (auth.token || 'spectator') } })
  onUnmounted(() => socket.disconnect())
  return socket
}
