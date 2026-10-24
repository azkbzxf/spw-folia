/* Online-music provider registry shim.
 *
 * Folia's `services/onlineMusic/providerRegistry.ts` statically imports every provider adapter
 * (netease / kugou / qq / bodian / ytm / spotify / qishui), and each of those pulls a Node-only SDK
 * plus its own worker plumbing — none of it can live in the injected settings page, which only draws
 * the settings window. The registry is what makes the adapters reachable, so stubbing it keeps the
 * whole adapter graph out of the bundle.
 *
 * With no providers registered every lookup misses and Folia's own call sites fall back to the
 * provider-neutral path (`createProviderSongMetadata`), which is the correct answer here: the host
 * app owns playback and sends finished metadata over the bridge. */
import type { OnlineMusicProvider, OnlineProviderId } from '@/types/onlineMusic';
import type { SongResult } from '@/types';

const providers = new Map<OnlineProviderId, OnlineMusicProvider>();

export const registerOnlineMusicProvider = (provider: OnlineMusicProvider): void => {
    providers.set(provider.id, provider);
};

export const unregisterOnlineMusicProvider = (providerId: OnlineProviderId): void => {
    providers.delete(providerId);
};

export const getOnlineMusicProviderRegistryVersion = (): number => 0;

export const subscribeOnlineMusicProviderRegistry = (_listener: () => void): (() => void) => () => undefined;

export const getOnlineMusicProvider = (_providerId: OnlineProviderId): OnlineMusicProvider | null => null;

export const listOnlineMusicProviders = (): OnlineMusicProvider[] => [];

export const requireOnlineMusicProvider = (providerId: OnlineProviderId): OnlineMusicProvider => {
    throw new Error(`[spw-folia] no online music provider "${providerId}" in the injected page`);
};

export const providerSupports = (): boolean => false;

export const getOnlineMusicProviderForSong = (_song: SongResult): OnlineMusicProvider | null => null;

export const keepsOwnSongAudio = (_song: SongResult): boolean => false;

export const hasProviderKeptSongAudio = async (_song: SongResult, _url: string): Promise<boolean> => false;

export const keepProviderSongAudio = async (_song: SongResult, _url: string): Promise<boolean> => false;

export const canPlayOnlineMusicSong = (_song: SongResult): boolean => false;

export const requireOnlineMusicProviderForSong = (song: SongResult): OnlineMusicProvider => {
    throw new Error(`[spw-folia] no online music provider for song ${String(song?.id)} in the injected page`);
};
