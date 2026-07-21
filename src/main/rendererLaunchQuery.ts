export type RendererLaunchFlags = {
  readonly pcm16ColdCache: boolean;
  readonly wamDspTest: boolean;
  readonly wamSmoke: boolean;
  readonly audioCacheSmoke: boolean;
};

export type RendererLaunchQuery = Readonly<Record<"pcm16ColdCache", "1">> | undefined;

export function getRendererLaunchQuery(flags: RendererLaunchFlags): RendererLaunchQuery {
  if (!flags.pcm16ColdCache || flags.wamDspTest || flags.wamSmoke) return undefined;
  return { pcm16ColdCache: "1" };
}

export function buildRendererLaunchUrl(url: string, query: RendererLaunchQuery): string {
  if (!query) return url;
  const target = new URL(url);
  for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value);
  return target.toString();
}
