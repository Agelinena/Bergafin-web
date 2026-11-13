/**
 * Perfil de reprodução do Chromecast antigo (1ª e 2ª geração) com o Default Media Receiver.
 *
 * - Toca direto: H.264 até 1080p (nível 4.1, 8 bits) em MP4, VP8 em WebM, AAC/MP3 estéreo.
 * - O resto vira HLS (H.264 + AAC). Quando dá, o vídeo é só copiado (remux), o que é rápido.
 * - Legenda de texto vai como WebVTT (faixa da mídia, sem transcodificar).
 *   Legenda de imagem (PGS, VobSub) é gravada no vídeo (Encode).
 *
 * Baseado no deviceprofileBuilder do receptor oficial (jellyfin-chromecast, GPL-2.0).
 */
export function chromecastProfile(maxBitrate) {
    return {
        Name: 'Bergafin Chromecast (Default Media Receiver)',
        MaxStreamingBitrate: maxBitrate,
        MaxStaticBitrate: maxBitrate,
        MusicStreamingTranscodingBitrate: 192000,
        DirectPlayProfiles: [
            { Container: 'mp4,m4v', Type: 'Video', VideoCodec: 'h264', AudioCodec: 'aac,mp3' },
            { Container: 'webm', Type: 'Video', VideoCodec: 'vp8', AudioCodec: 'vorbis,opus' },
            { Container: 'mp3', Type: 'Audio' },
            { Container: 'aac,m4a,m4b', Type: 'Audio', AudioCodec: 'aac' },
            { Container: 'flac', Type: 'Audio' },
            { Container: 'webm,ogg,oga', Type: 'Audio', AudioCodec: 'vorbis,opus' },
            { Container: 'wav', Type: 'Audio' }
        ],
        TranscodingProfiles: [
            {
                Container: 'ts',
                Type: 'Video',
                VideoCodec: 'h264',
                AudioCodec: 'aac,mp3',
                Protocol: 'hls',
                Context: 'Streaming',
                MaxAudioChannels: '2',
                MinSegments: 1,
                BreakOnNonKeyFrames: true
            },
            {
                Container: 'mp3',
                Type: 'Audio',
                AudioCodec: 'mp3',
                Protocol: 'http',
                Context: 'Streaming',
                MaxAudioChannels: '2'
            }
        ],
        ContainerProfiles: [],
        CodecProfiles: [
            {
                Type: 'Video',
                Codec: 'h264',
                Conditions: [
                    { Condition: 'EqualsAny', Property: 'VideoProfile', Value: 'high|main|baseline|constrained baseline', IsRequired: false },
                    { Condition: 'LessThanEqual', Property: 'VideoLevel', Value: '41', IsRequired: false },
                    { Condition: 'LessThanEqual', Property: 'VideoBitDepth', Value: '8', IsRequired: false },
                    { Condition: 'LessThanEqual', Property: 'Width', Value: '1920', IsRequired: true },
                    { Condition: 'LessThanEqual', Property: 'Height', Value: '1080', IsRequired: true },
                    { Condition: 'LessThanEqual', Property: 'VideoFramerate', Value: '30', IsRequired: false }
                ]
            },
            {
                Type: 'VideoAudio',
                Conditions: [
                    { Condition: 'LessThanEqual', Property: 'AudioChannels', Value: '2', IsRequired: true }
                ]
            },
            {
                Type: 'Audio',
                Conditions: [
                    { Condition: 'LessThanEqual', Property: 'AudioChannels', Value: '2', IsRequired: true }
                ]
            }
        ],
        SubtitleProfiles: [
            { Format: 'vtt', Method: 'External' }
        ]
    };
}
