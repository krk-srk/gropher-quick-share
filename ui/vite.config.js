import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // This allows the specific Cloudflare Tunnel host provided in your error message
    allowedHosts: [
      'buffalo-libraries-willing-fruits.trycloudflare.com'
    ],
    
    // Alternatively, if your tunnel URL changes every time, 
    // you can use the line below instead to allow all hosts:
    // allowedHosts: true 
  }
})
