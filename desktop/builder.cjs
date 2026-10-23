module.exports = {
  appId: 'io.cloudharness.desktop',
  productName: 'Cloud Harness',
  directories: { output: 'desktop-dist' },
  extraMetadata: { main: 'desktop/main.mjs', name: 'cloud-harness-desktop' },
  files: ['desktop/**', 'package.json'],
  asar: true,
  mac: {
    target: ['dmg', 'zip'],
    category: 'public.app-category.developer-tools',
    extendInfo: {
      NSMicrophoneUsageDescription:
        'Microphone access is used only when you choose voice dictation.',
    },
  },
  win: { target: ['nsis'] },
  nsis: { oneClick: false, allowToChangeInstallationDirectory: true },
  linux: { target: ['AppImage', 'deb'], category: 'Development' },
};
