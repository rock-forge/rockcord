'use strict';

module.exports = (client, packet) => {
  client.emit('debug', '[VOICE] received voice server update');
  client.voice.onVoiceServer(packet.d);
};
