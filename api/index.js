import app from '../server/index.mjs'

export default function handler(request, response) {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
  const path = url.searchParams.get('path')
  if (path) {
    url.searchParams.delete('path')
    request.url = `/api/${path}${url.search}`
  }
  return app(request, response)
}
