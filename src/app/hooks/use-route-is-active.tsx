import { useCallback } from 'react'
import { useLocation } from 'react-router-dom'
import { libraryItems, mainNavItems } from '@/app/layout/sidebar'
import { ROUTES } from '@/routes/routesList'

type ParsedRoute = {
  pathname: string
  query?: string
}

type QueryRouteCandidate = {
  pathname: string
  normalizedQuery: string
  params: [string, string][]
  index: number
}

function parseRoute(route: string): ParsedRoute {
  const queryIndex = route.indexOf('?')
  if (queryIndex < 0) {
    return { pathname: route }
  }

  return {
    pathname: route.slice(0, queryIndex),
    query: route.slice(queryIndex + 1),
  }
}

function normalizeQuery(query: string): string {
  const params = new URLSearchParams(query)
  const entries = [...params.entries()].sort(([keyA, valueA], [keyB, valueB]) => {
    if (keyA === keyB) return valueA.localeCompare(valueB)
    return keyA.localeCompare(keyB)
  })

  return entries.map(([key, value]) => `${key}=${value}`).join('&')
}

function queryEntries(query: string): [string, string][] {
  return [...new URLSearchParams(query).entries()]
}

function querySubsetMatches(
  routeEntries: [string, string][],
  currentParams: URLSearchParams,
): boolean {
  for (const [key, value] of routeEntries) {
    if (currentParams.get(key) !== value) return false
  }

  return true
}

function queryExactlyMatches(
  routeEntries: [string, string][],
  currentParams: URLSearchParams,
): boolean {
  if (!querySubsetMatches(routeEntries, currentParams)) return false

  const currentEntriesCount = [...currentParams.entries()].length
  return routeEntries.length === currentEntriesCount
}

const queryRouteCandidates: QueryRouteCandidate[] = [...mainNavItems, ...libraryItems]
  .map((item) => parseRoute(item.route))
  .filter((route): route is { pathname: string; query: string } =>
    typeof route.query === 'string' && route.query.length > 0,
  )
  .map((route, index) => ({
    pathname: route.pathname,
    normalizedQuery: normalizeQuery(route.query),
    params: queryEntries(route.query),
    index,
  }))

function findBestQueryCandidate(
  pathname: string,
  currentParams: URLSearchParams,
): QueryRouteCandidate | null {
  const matches = queryRouteCandidates.filter(
    (candidate) =>
      candidate.pathname === pathname &&
      querySubsetMatches(candidate.params, currentParams),
  )
  if (matches.length === 0) return null

  const exactMatch = matches.find((candidate) =>
    queryExactlyMatches(candidate.params, currentParams),
  )
  if (exactMatch) return exactMatch

  return matches.reduce((best, current) => {
    if (current.params.length > best.params.length) return current
    if (current.params.length < best.params.length) return best

    return current.index < best.index ? current : best
  })
}

export function useRouteIsActive() {
  const location = useLocation()

  const isActive = useCallback(
    (route: string) => {
      const parsedRoute = parseRoute(route)
      if (location.pathname !== parsedRoute.pathname) {
        return false
      }

      const currentParams = new URLSearchParams(
        location.search.startsWith('?')
          ? location.search.slice(1)
          : location.search,
      )
      const bestQueryCandidate = findBestQueryCandidate(
        parsedRoute.pathname,
        currentParams,
      )

      if (parsedRoute.query) {
        const routeEntries = queryEntries(parsedRoute.query)
        if (!querySubsetMatches(routeEntries, currentParams)) {
          return false
        }

        if (!bestQueryCandidate) return true
        return bestQueryCandidate.normalizedQuery === normalizeQuery(parsedRoute.query)
      }

      return !bestQueryCandidate
    },
    [location.pathname, location.search],
  )

  const isOnPlaylist = useCallback(
    (id: string) => {
      return location.pathname === ROUTES.PLAYLIST.PAGE(id)
    },
    [location.pathname],
  )

  return {
    isActive,
    isOnPlaylist,
  }
}
