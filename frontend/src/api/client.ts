// Thin fetch wrapper. Access token kept in memory + sessionStorage (survives
// a reload, not a browser restart) rather than localStorage — a JWT with a
// 15-minute expiry is refreshed via the httpOnly refresh cookie anyway.
const TOKEN_KEY = 'cortexarr_access_token'

let accessToken: string | null = sessionStorage.getItem(TOKEN_KEY)

export function setAccessToken(token: string | null) {
  accessToken = token
  if (token) sessionStorage.setItem(TOKEN_KEY, token)
  else sessionStorage.removeItem(TOKEN_KEY)
}

export function getAccessToken() {
  return accessToken
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, options: RequestInit = {}, retry = true): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  }
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`

  const resp = await fetch(`/api${path}`, { ...options, headers, credentials: 'include' })

  if (resp.status === 401 && retry) {
    const refreshed = await tryRefresh()
    if (refreshed) return request<T>(path, options, false)
  }

  if (!resp.ok) {
    let detail = resp.statusText
    try {
      const body = await resp.json()
      detail = body.detail || detail
    } catch {
      // no JSON body
    }
    throw new ApiError(resp.status, detail)
  }

  if (resp.status === 204) return undefined as T
  return resp.json()
}

async function tryRefresh(): Promise<boolean> {
  try {
    const resp = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
    if (!resp.ok) return false
    const data = await resp.json()
    setAccessToken(data.access_token)
    return true
  } catch {
    return false
  }
}

export const api = {
  get: <T,>(path: string) => request<T>(path),
  post: <T,>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined }),
  put: <T,>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body !== undefined ? JSON.stringify(body) : undefined }),
  patch: <T,>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body !== undefined ? JSON.stringify(body) : undefined }),
  delete: <T,>(path: string) => request<T>(path, { method: 'DELETE' }),
}
