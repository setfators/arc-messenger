const { contextBridge, ipcRenderer } = require('electron');

// Мост для окна оверлея. Странице оверлея доступно только это:
// приём состояния звонка, всплывающие сообщения, режим мыши и микрофон.
contextBridge.exposeInMainWorld('arcOverlay', {
  onState: (cb) => {
    const handler = (_event, state) => { try { cb(state); } catch (e) {} };
    ipcRenderer.on('overlay:state', handler);
    return () => ipcRenderer.removeListener('overlay:state', handler);
  },
  onToast: (cb) => {
    const handler = (_event, payload) => { try { cb(payload); } catch (e) {} };
    ipcRenderer.on('overlay:toast', handler);
    return () => ipcRenderer.removeListener('overlay:toast', handler);
  },
  onMode: (cb) => {
    const handler = (_event, on) => { try { cb(!!on); } catch (e) {} };
    ipcRenderer.on('overlay:mode', handler);
    return () => ipcRenderer.removeListener('overlay:mode', handler);
  },
  onConfig: (cb) => {
    const handler = (_event, cfg) => { try { cb(cfg || {}); } catch (e) {} };
    ipcRenderer.on('overlay:config', handler);
    return () => ipcRenderer.removeListener('overlay:config', handler);
  },
  toggleMic: () => ipcRenderer.send('overlay:mic-toggle'),
  exitInteractive: () => ipcRenderer.send('overlay:interactive', false),
  ready: () => ipcRenderer.send('overlay:ready')
});
