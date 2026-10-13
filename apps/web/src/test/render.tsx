import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type RenderResult, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';

/** Renders a component the way the app does: inside a router and a query client (with retries off). */
export function renderInApp(ui: ReactElement, options: { route?: string } = {}): RenderResult & { queryClient: QueryClient } {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[options.route ?? '/']}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
  return Object.assign(result, { queryClient });
}

/** A JSON `Response`, as the server would send it. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** The server's error envelope. */
export function errorResponse(status: number, code: string, message = 'Refused.', details?: unknown): Response {
  return jsonResponse({ error: { code, message, ...(details === undefined ? {} : { details }) } }, status);
}
