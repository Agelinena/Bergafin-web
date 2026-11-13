/**
 * Bergafin: cast pelo Default Media Receiver do Google (grátis, sem registro).
 *
 * O web oficial manda comandos ("PlayNow", "Seek", "SetSubtitleStreamIndex"…) para o
 * receptor do Jellyfin, que roda dentro do Chromecast e faz todo o resto. Aqui esse
 * receptor é emulado no próprio celular/PC: ele recebe os mesmos comandos, escolhe o
 * stream no servidor, manda só o link para o Chromecast, cuida da fila, das legendas e
 * do áudio, informa o progresso ao Jellyfin e devolve ao web os mesmos eventos
 * (playbackstart, playbackprogress, pause…) que o receptor oficial devolveria.
 *
 * O plugin oficial (plugins/chromecastPlayer) só ganhou dois ganchos: o ID do receptor
 * e o envio das mensagens (que vêm para cá em vez de irem ao Chromecast).
 *
 * Lógica de stream e de relatório baseada no jellyfin-chromecast (GPL-2.0).
 */
import { ServerConnections } from 'lib/jellyfin-apiclient';
import Events from '../../utils/events.ts';
import alert from '../../components/alert';
import { chromecastProfile } from './deviceProfile';

/** ID do Default Media Receiver (CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID). */
export const DMR_APP_ID = 'CC1AD845';

const TICKS_PER_SECOND = 10000000;
const DEFAULT_MAX_BITRATE = 20000000;
const UI_INTERVAL_MS = 1000;
const SERVER_INTERVAL_MS = 10000;

function cast() {
    return window.chrome.cast;
}

/** Usa o construtor do SDK quando existe (Chrome desktop); o shim do app aceita objeto simples. */
function make(ctorName, args, props) {
    const media = cast().media;
    const Ctor = media[ctorName];
    const obj = typeof Ctor === 'function' ? new Ctor(...args) : {};
    return Object.assign(obj, props);
}

function withApiKey(url, apiClient) {
    if (/[?&](api_key|ApiKey)=/i.test(url)) {
        return url;
    }
    return url + (url.includes('?') ? '&' : '?') + 'api_key=' + encodeURIComponent(apiClient.accessToken());
}

function absolute(url, apiClient) {
    return /^https?:\/\//i.test(url) ? url : apiClient.serverAddress().replace(/\/+$/, '') + url;
}

class DmrReceiver {
    constructor() {
        this.castPlayer = null;
        this.apiClient = null;
        this.maxBitrate = DEFAULT_MAX_BITRATE;
        this.repeatMode = 'RepeatNone';
        this.queue = [];
        this.index = -1;
        this.current = null;
        this.media = null;
        this.loadId = 0;
        this.lastPlayerState = null;
        this.uiTimer = null;
        this.serverTimer = null;
    }

    /** Sessão encerrada: esquece tudo. */
    reset() {
        this.stopTimers();
        this.queue = [];
        this.index = -1;
        this.current = null;
        this.media = null;
        this.lastPlayerState = null;
    }

    /** Recebe uma mensagem que iria para o receptor do Jellyfin. */
    handle(castPlayer, message) {
        this.castPlayer = castPlayer;
        this.apiClient = (message.serverId && ServerConnections.getApiClient(message.serverId))
            || ServerConnections.currentApiClient();
        if (message.maxBitrate) {
            this.maxBitrate = message.maxBitrate;
        }

        return this.run(message.command, message.options || {}).catch(err => {
            console.error('[Bergafin cast] ' + message.command, err);
            this.showError('Não foi possível transmitir: ' + (err?.message || err));
        });
    }

    async run(command, o) {
        switch (command) {
            case 'Identify':
            case 'DisplayContent':
                return;
            case 'PlayNow':
                return this.playNow(o.items, o.startIndex || 0, {
                    startTicks: o.startPositionTicks || 0,
                    audio: o.audioStreamIndex,
                    subtitle: o.subtitleStreamIndex,
                    mediaSourceId: o.mediaSourceId
                });
            case 'PlayNext':
                if (!this.current) return this.playNow(o.items, 0, {});
                this.queue.splice(this.index + 1, 0, ...o.items);
                return;
            case 'PlayLast':
                if (!this.current) return this.playNow(o.items, 0, {});
                this.queue.push(...o.items);
                return;
            case 'Shuffle':
                return this.playNow(await this.shuffleItems(o.items[0]), 0, {});
            case 'InstantMix':
                return this.playNow(await this.instantMixItems(o.items[0]), 0, {});
            case 'Pause':
                return this.mediaCall('pause');
            case 'Unpause':
                return this.mediaCall('play');
            case 'PlayPause':
                return this.mediaCall(this.getMedia()?.playerState === 'PAUSED' ? 'play' : 'pause');
            case 'Seek':
                return this.seek(o.position);
            case 'Stop':
                return this.stop();
            case 'NextTrack':
                return this.next(true);
            case 'PreviousTrack':
                return this.previous();
            case 'SetAudioStreamIndex':
                return this.reload({ audio: o.index });
            case 'SetSubtitleStreamIndex':
                return this.setSubtitle(o.index);
            case 'SetMaxStreamingBitrate':
                if (o.maxBitrate) this.maxBitrate = o.maxBitrate;
                return this.reload({});
            case 'SetRepeatMode':
                this.repeatMode = o.RepeatMode || 'RepeatNone';
                this.emit('repeatmodechange');
                return;
            case 'Mute':
                return this.setMuted(true);
            case 'Unmute':
                return this.setMuted(false);
            case 'ToggleMute':
                return this.setMuted(!this.castPlayer.session?.receiver?.volume?.muted);
            case 'SetVolume':
                return this.setVolume((o.volume ?? 100) / 100);
            case 'VolumeUp':
                return this.setVolume(this.volumeLevel() + 0.05);
            case 'VolumeDown':
                return this.setVolume(this.volumeLevel() - 0.05);
            default:
                console.debug('[Bergafin cast] comando ignorado: ' + command);
        }
    }

    // ---- Fila -------------------------------------------------------------

    async playNow(items, startIndex, opts) {
        if (!items?.length) return;
        this.queue = items.slice();
        await this.playIndex(Math.min(startIndex, items.length - 1), opts);
    }

    async next(manual) {
        if (!this.queue.length) return;
        let i = this.index + 1;
        if (!manual && this.repeatMode === 'RepeatOne') {
            i = this.index;
        } else if (i >= this.queue.length) {
            if (this.repeatMode !== 'RepeatAll') {
                await this.finish();
                return;
            }
            i = 0;
        }
        await this.playIndex(i, {});
    }

    async previous() {
        // Como nos players: nos primeiros segundos volta ao anterior, depois recomeça
        if (this.positionTicks() > 5 * TICKS_PER_SECOND || this.index <= 0) {
            await this.seek(0);
            return;
        }
        await this.playIndex(this.index - 1, {});
    }

    async shuffleItems(seed) {
        const result = await this.apiClient.getItems(this.apiClient.getCurrentUserId(), {
            ParentId: seed.Id,
            SortBy: 'Random',
            Recursive: true,
            IsFolder: false,
            MediaTypes: 'Audio,Video',
            Limit: 200
        });
        return result.Items || [];
    }

    async instantMixItems(seed) {
        const result = await this.apiClient.getInstantMixFromItem(seed.Id, {
            UserId: this.apiClient.getCurrentUserId(),
            Limit: 200
        });
        return result.Items || [];
    }

    // ---- Tocar um item ------------------------------------------------------

    async playIndex(index, opts) {
        const loadId = ++this.loadId;
        await this.reportStopped();
        this.stopTimers();
        this.index = index;

        const apiClient = this.apiClient;
        const userId = apiClient.getCurrentUserId();
        const item = await apiClient.getItem(userId, this.queue[index].Id);
        const startTicks = opts.startTicks || 0;

        const query = {
            UserId: userId,
            StartTimeTicks: startTicks,
            IsPlayback: true,
            AutoOpenLiveStream: true,
            MaxStreamingBitrate: this.maxBitrate
        };
        if (opts.audio != null) query.AudioStreamIndex = opts.audio;
        if (opts.subtitle != null) query.SubtitleStreamIndex = opts.subtitle;
        if (opts.mediaSourceId) query.MediaSourceId = opts.mediaSourceId;

        const info = await apiClient.getPlaybackInfo(item.Id, query, chromecastProfile(this.maxBitrate));
        if (loadId !== this.loadId) return; // outro comando chegou no meio

        const mediaSource = (opts.mediaSourceId && info.MediaSources.find(m => m.Id === opts.mediaSourceId))
            || info.MediaSources[0];
        if (!mediaSource || info.ErrorCode) {
            throw new Error(info.ErrorCode || 'item sem mídia');
        }

        const stream = this.streamFor(item, mediaSource, info.PlaySessionId);
        const audioIndex = opts.audio ?? mediaSource.DefaultAudioStreamIndex;
        const subtitleIndex = opts.subtitle ?? mediaSource.DefaultSubtitleStreamIndex ?? -1;
        const tracks = this.subtitleTracks(mediaSource);
        const activeTrackIds = tracks.some(t => t.trackId === subtitleIndex + 1) ? [subtitleIndex + 1] : [];

        this.current = {
            item,
            mediaSource,
            playSessionId: info.PlaySessionId,
            playMethod: stream.playMethod,
            audioIndex,
            subtitleIndex,
            liveStreamId: mediaSource.LiveStreamId
        };

        const mediaInfo = make('MediaInfo', [stream.url, stream.contentType], {
            contentId: stream.url,
            contentType: stream.contentType,
            streamType: cast().media.StreamType.BUFFERED,
            duration: mediaSource.RunTimeTicks ? mediaSource.RunTimeTicks / TICKS_PER_SECOND : null,
            metadata: this.metadataFor(item),
            tracks,
            textTrackStyle: make('TextTrackStyle', [], {
                foregroundColor: '#FFFFFFFF',
                backgroundColor: '#00000000',
                edgeType: 'DROP_SHADOW',
                edgeColor: '#000000FF',
                fontScale: 1.0
            }),
            customData: { bergafin: { itemId: item.Id, mediaSourceId: mediaSource.Id, playSessionId: info.PlaySessionId } }
        });
        const queueItem = make('QueueItem', [mediaInfo], {
            media: mediaInfo,
            autoplay: true,
            startTime: startTicks / TICKS_PER_SECOND,
            activeTrackIds
        });
        const request = make('QueueLoadRequest', [[queueItem]], {
            items: [queueItem],
            startIndex: 0,
            repeatMode: 'REPEAT_OFF'
        });

        const media = await new Promise((resolve, reject) => {
            this.castPlayer.session.queueLoad(request, resolve, reject);
        });
        if (loadId !== this.loadId) return;

        this.attachMedia(media);
        await this.reportStarted();
        this.startTimers();
    }

    /** Mesmo item, outra opção (áudio, legenda, qualidade), na posição atual. */
    async reload(changes) {
        if (!this.current) return;
        const startTicks = this.positionTicks();
        await this.stopEncoding();
        await this.playIndex(this.index, {
            startTicks,
            audio: changes.audio ?? this.current.audioIndex,
            subtitle: changes.subtitle ?? this.current.subtitleIndex,
            mediaSourceId: this.current.mediaSource.Id
        });
    }

    async setSubtitle(index) {
        if (!this.current) return;
        const current = this.current;
        const burned = this.isBurnedIn(current.mediaSource, current.subtitleIndex);
        const target = index == null ? -1 : index;
        const hasTrack = this.subtitleTracks(current.mediaSource).some(t => t.trackId === target + 1);

        // Legenda de texto já carregada como faixa: troca na hora, sem recarregar
        if (!burned && (target === -1 || hasTrack)) {
            await this.editTracks(target === -1 ? [] : [target + 1]);
            current.subtitleIndex = target;
            this.emit('playbackprogress');
            return;
        }
        // Legenda de imagem (gravada no vídeo) entra ou sai: precisa transcodificar de novo
        await this.reload({ subtitle: target });
    }

    streamFor(item, ms, playSessionId) {
        const apiClient = this.apiClient;
        const isVideo = item.MediaType === 'Video';
        if (ms.SupportsDirectStream || ms.SupportsDirectPlay) {
            const path = (isVideo ? 'Videos/' : 'Audio/') + item.Id + '/stream.' + ms.Container;
            const url = apiClient.getUrl(path, {
                static: true,
                mediaSourceId: ms.Id,
                deviceId: apiClient.deviceId(),
                PlaySessionId: playSessionId
            });
            return {
                url: withApiKey(url, apiClient),
                contentType: (isVideo ? 'video/' : 'audio/') + (ms.Container === 'm4v' ? 'mp4' : ms.Container),
                playMethod: ms.SupportsDirectPlay ? 'DirectPlay' : 'DirectStream'
            };
        }
        if (!ms.TranscodingUrl) {
            throw new Error('o servidor não ofereceu um formato que o Chromecast toque');
        }
        const isHls = (ms.TranscodingSubProtocol || '').toLowerCase() === 'hls'
            || /\.m3u8/i.test(ms.TranscodingUrl);
        return {
            url: withApiKey(absolute(ms.TranscodingUrl, apiClient), apiClient),
            contentType: isHls ? 'application/x-mpegURL' : (isVideo ? 'video/' : 'audio/') + ms.TranscodingContainer,
            playMethod: 'Transcode'
        };
    }

    /** Legendas de texto entregues como arquivo WebVTT. trackId = índice do stream + 1. */
    subtitleTracks(ms) {
        const apiClient = this.apiClient;
        return (ms.MediaStreams || [])
            .filter(s => s.Type === 'Subtitle' && s.DeliveryMethod === 'External' && s.DeliveryUrl)
            .map(s => make('Track', [s.Index + 1, cast().media.TrackType.TEXT], {
                trackId: s.Index + 1,
                type: cast().media.TrackType.TEXT,
                subtype: cast().media.TextTrackType.SUBTITLES,
                trackContentId: withApiKey(absolute(s.DeliveryUrl, apiClient), apiClient),
                trackContentType: 'text/vtt',
                name: s.DisplayTitle || s.Title || s.Language || ('Legenda ' + s.Index),
                language: s.Language || null
            }));
    }

    isBurnedIn(ms, index) {
        if (index == null || index < 0) return false;
        const stream = (ms.MediaStreams || []).find(s => s.Index === index);
        return !!stream && stream.DeliveryMethod === 'Encode';
    }

    metadataFor(item) {
        const types = cast().media.MetadataType;
        const imageId = item.Type === 'Episode' && item.SeriesPrimaryImageTag ? item.SeriesId : item.Id;
        const tag = item.Type === 'Episode' && item.SeriesPrimaryImageTag ? item.SeriesPrimaryImageTag : item.ImageTags?.Primary;
        const images = tag ? [{ url: this.apiClient.getScaledImageUrl(imageId, { type: 'Primary', tag, maxWidth: 800 }) }] : [];

        if (item.Type === 'Episode') {
            return make('TvShowMediaMetadata', [], {
                metadataType: types.TV_SHOW,
                title: item.Name,
                seriesTitle: item.SeriesName,
                season: item.ParentIndexNumber,
                episode: item.IndexNumber,
                images
            });
        }
        if (item.MediaType === 'Audio') {
            return make('MusicTrackMediaMetadata', [], {
                metadataType: types.MUSIC_TRACK,
                title: item.Name,
                artist: (item.Artists || []).join(', '),
                albumName: item.Album,
                images
            });
        }
        if (item.Type === 'Movie') {
            return make('MovieMediaMetadata', [], {
                metadataType: types.MOVIE,
                title: item.Name,
                subtitle: item.ProductionYear ? String(item.ProductionYear) : undefined,
                images
            });
        }
        return make('GenericMediaMetadata', [], { metadataType: types.GENERIC, title: item.Name, images });
    }

    // ---- Controle da mídia no Chromecast ----------------------------------------

    getMedia() {
        return this.media || this.castPlayer?.currentMediaSession || null;
    }

    attachMedia(media) {
        this.media = media;
        this.lastPlayerState = media.playerState;
        media.addUpdateListener(() => this.onMediaUpdate(media));
    }

    mediaCall(method) {
        const media = this.getMedia();
        if (!media) return Promise.resolve();
        return new Promise((resolve, reject) => {
            media[method](null, resolve, reject);
        });
    }

    seek(positionSeconds) {
        const media = this.getMedia();
        if (!media) return Promise.resolve();
        const request = make('SeekRequest', [], { currentTime: positionSeconds });
        return new Promise((resolve, reject) => media.seek(request, resolve, reject))
            .then(() => this.emit('playbackprogress'));
    }

    editTracks(activeTrackIds) {
        const media = this.getMedia();
        if (!media) return Promise.resolve();
        const request = make('EditTracksInfoRequest', [activeTrackIds], { activeTrackIds });
        return new Promise((resolve, reject) => media.editTracksInfo(request, resolve, reject));
    }

    volumeLevel() {
        return this.castPlayer?.session?.receiver?.volume?.level ?? 0.5;
    }

    setVolume(level) {
        const session = this.castPlayer?.session;
        if (!session) return Promise.resolve();
        const value = Math.min(1, Math.max(0, level));
        return new Promise((resolve, reject) => session.setReceiverVolumeLevel(value, resolve, reject))
            .then(() => this.emit('volumechange'));
    }

    setMuted(muted) {
        const session = this.castPlayer?.session;
        if (!session) return Promise.resolve();
        return new Promise((resolve, reject) => session.setReceiverMuted(muted, resolve, reject))
            .then(() => this.emit('volumechange'));
    }

    async stop() {
        this.loadId++;
        const media = this.getMedia();
        if (media) {
            await new Promise(resolve => media.stop(null, resolve, resolve));
        }
        await this.finish();
    }

    /** Fim da fila (ou Stop): informa o servidor e o web. */
    async finish() {
        const data = this.state();
        await this.reportStopped();
        this.stopTimers();
        this.current = null;
        this.media = null;
        this.queue = [];
        this.index = -1;
        if (data) {
            Events.trigger(this.castPlayer, 'playbackstop', [data]);
        }
    }

    onMediaUpdate(media) {
        if (media !== this.media) return; // mídia antiga (já trocamos de item)
        const state = media.playerState;

        if (state === 'IDLE') {
            const reason = media.idleReason;
            if (reason === 'FINISHED') {
                this.media = null;
                this.next(false).catch(err => this.showError(err?.message || err));
            } else if (reason === 'ERROR') {
                this.media = null;
                this.showError('O Chromecast não conseguiu tocar este item.');
                this.finish();
            } else if (reason === 'CANCELLED') {
                // Parado pela notificação do celular ou por outro aparelho
                this.media = null;
                this.finish();
            }
            return;
        }

        if (state !== this.lastPlayerState) {
            const wasPaused = this.lastPlayerState === 'PAUSED';
            this.lastPlayerState = state;
            if (state === 'PAUSED') {
                this.emit('pause');
                this.reportProgress('pause');
            } else if (wasPaused && state === 'PLAYING') {
                this.emit('unpause');
                this.reportProgress('unpause');
            }
        }
    }

    // ---- Estado e relatório ao servidor ------------------------------------

    positionTicks() {
        const media = this.getMedia();
        const seconds = media?.getEstimatedTime ? media.getEstimatedTime() : media?.currentTime;
        return Math.max(0, Math.round((seconds || 0) * TICKS_PER_SECOND));
    }

    reportingParams(eventName) {
        const c = this.current;
        if (!c) return null;
        const volume = this.castPlayer?.session?.receiver?.volume || {};
        return {
            ItemId: c.item.Id,
            MediaSourceId: c.mediaSource.Id,
            PlaySessionId: c.playSessionId,
            LiveStreamId: c.liveStreamId,
            PositionTicks: this.positionTicks(),
            IsPaused: this.getMedia()?.playerState === 'PAUSED',
            IsMuted: !!volume.muted,
            VolumeLevel: Math.round((volume.level ?? 1) * 100),
            AudioStreamIndex: c.audioIndex,
            SubtitleStreamIndex: c.subtitleIndex,
            PlayMethod: c.playMethod,
            RepeatMode: this.repeatMode,
            MaxStreamingBitrate: this.maxBitrate,
            CanSeek: (c.mediaSource.RunTimeTicks || 0) > 0,
            EventName: eventName
        };
    }

    /** Mesmo formato do getSenderReportingData do receptor oficial. */
    state(eventName) {
        const params = this.reportingParams(eventName);
        if (!params) return null;
        const item = this.current.item;
        const imageTags = item.ImageTags || {};
        const nowPlaying = {
            Id: item.Id,
            ServerId: item.ServerId,
            RunTimeTicks: this.current.mediaSource.RunTimeTicks || item.RunTimeTicks,
            Chapters: item.Chapters || [],
            MediaStreams: this.current.mediaSource.MediaStreams || [],
            MediaType: item.MediaType,
            Type: item.Type,
            Name: item.Name,
            IndexNumber: item.IndexNumber,
            ParentIndexNumber: item.ParentIndexNumber,
            ProductionYear: item.ProductionYear,
            SeriesName: item.SeriesName,
            SeriesId: item.SeriesId,
            Album: item.Album,
            AlbumId: item.AlbumId,
            Artists: item.Artists
        };
        if (item.SeriesPrimaryImageTag) {
            nowPlaying.PrimaryImageItemId = item.SeriesId;
            nowPlaying.PrimaryImageTag = item.SeriesPrimaryImageTag;
        } else if (imageTags.Primary) {
            nowPlaying.PrimaryImageItemId = item.Id;
            nowPlaying.PrimaryImageTag = imageTags.Primary;
        } else if (item.AlbumPrimaryImageTag) {
            nowPlaying.PrimaryImageItemId = item.AlbumId;
            nowPlaying.PrimaryImageTag = item.AlbumPrimaryImageTag;
        }
        if (item.BackdropImageTags?.length) {
            nowPlaying.BackdropItemId = item.Id;
            nowPlaying.BackdropImageTag = item.BackdropImageTags[0];
        } else if (item.ParentBackdropImageTags?.length) {
            nowPlaying.BackdropItemId = item.ParentBackdropItemId;
            nowPlaying.BackdropImageTag = item.ParentBackdropImageTags[0];
        }
        return { ItemId: item.Id, PlayState: params, NowPlayingItem: nowPlaying };
    }

    emit(type) {
        const data = this.state(type);
        if (data && this.castPlayer) {
            Events.trigger(this.castPlayer, type, [data]);
        }
    }

    async reportStarted() {
        const params = this.reportingParams();
        if (!params) return;
        this.emit('playbackstart');
        await this.apiClient.reportPlaybackStart(params).catch(err => console.warn('[Bergafin cast] start', err));
    }

    reportProgress(eventName) {
        const params = this.reportingParams(eventName || 'timeupdate');
        if (!params) return;
        this.apiClient.reportPlaybackProgress(params).catch(err => console.warn('[Bergafin cast] progress', err));
    }

    async reportStopped() {
        const params = this.reportingParams();
        if (!params) return;
        const wasTranscoding = this.current.playMethod === 'Transcode';
        await this.apiClient.reportPlaybackStopped(params).catch(err => console.warn('[Bergafin cast] stopped', err));
        if (wasTranscoding) {
            await this.stopEncoding();
        }
    }

    stopEncoding() {
        const c = this.current;
        if (!c || c.playMethod !== 'Transcode') return Promise.resolve();
        return this.apiClient.stopActiveEncodings(c.playSessionId).catch(() => {});
    }

    startTimers() {
        this.stopTimers();
        this.uiTimer = setInterval(() => {
            if (this.getMedia()?.playerState === 'PLAYING') {
                this.emit('playbackprogress');
            }
        }, UI_INTERVAL_MS);
        this.serverTimer = setInterval(() => {
            this.reportProgress('timeupdate');
            const c = this.current;
            if (c?.playMethod === 'Transcode') {
                // Mantém o transcode vivo enquanto o Chromecast toca
                this.apiClient.ajax({
                    type: 'POST',
                    url: this.apiClient.getUrl('Sessions/Playing/Ping', { playSessionId: c.playSessionId })
                }).catch(() => {});
            }
        }, SERVER_INTERVAL_MS);
    }

    stopTimers() {
        clearInterval(this.uiTimer);
        clearInterval(this.serverTimer);
        this.uiTimer = null;
        this.serverTimer = null;
    }

    showError(text) {
        alert({ title: 'Cast', text });
    }
}

export const dmrReceiver = new DmrReceiver();
