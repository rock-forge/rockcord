declare function expectType<T>(value: T): void;
import {
  Client,
  Message,
  MessageManager,
  ContainerComponent,
  FileComponent,
  UnfurledMediaItem,
  LimitedCollection,
  UserFlags,
  Recorder,
  MessageCollectorOptionsParams,
  ButtonInteraction,
  VoiceConnection,
} from '.';

const client = new Client({ retryLimit: 2, captchaRetryLimit: 3 });
declare const messages: MessageManager;
expectType<Promise<Message>>(messages.fetch('123'));
expectType<Promise<Message>>(messages.edit('123', { content: 'edit' }));
expectType<Promise<Message>>(messages.edit('123', { attachments: [] }));
// @ts-expect-error Message content must be a string.
messages.edit('123', { content: 123 });
expectType<ContainerComponent>(new ContainerComponent({ type: 17, components: [], accent_color: 0x123456 }));
expectType<FileComponent>(new FileComponent({ type: 13, file: { url: 'attachment://file.txt' } }));
expectType<string | null>(new UnfurledMediaItem({ url: 'https://example.com/image.png' }).url);
expectType<number>(new UserFlags().add('VERIFIED_EMAIL').bitfield);
expectType<LimitedCollection<string, number>>(new LimitedCollection<string, number>({ maxSize: 1 }, [['a', 1]]));
declare const options: MessageCollectorOptionsParams<'BUTTON', true>;
declare const interaction: ButtonInteraction<'cached'>;
options.filter?.(interaction);
expectType<Recorder<boolean, object>>(new Recorder<boolean, object>({}, { userId: '123', output: 'video.mkv' }));
client.destroy();

declare const connection: VoiceConnection;
expectType<string | null | undefined>(connection.dave?.voicePrivacyCode);
expectType<Promise<string> | undefined>(connection.dave?.getVerificationCode('123'));
connection.receiver.on('videoFrame', (user, bytes, codec) => {
  expectType<string>(user.userId);
  expectType<Buffer>(bytes);
  expectType<'H264' | 'H265' | 'VP8'>(codec);
});
connection.setVideoCodec('H265');
expectType<Recorder<false, any>>(connection.receiver.createVideoStream('123', 'capture.mkv', { codec: 'H265' }));
expectType<Recorder<false, any>>(connection.receiver.createVideoStream('123', 'capture.mkv', { codec: 'VP8' }));
const paced = connection.playVideo('video.mp4', { bitrate: 2000, congestionControl: { minBitrate: 128 } });
expectType<number | undefined>(paced.congestionControl?.state.targetBitrate);
