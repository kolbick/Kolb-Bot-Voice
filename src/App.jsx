import { useState, useEffect, useRef } from 'react';
import { useConversation } from '@elevenlabs/react';

export default function App() {
  const [config, setConfig] = useState(null);
  const [relayStatus, setRelayStatus] = useState({ connected: false, connecting: false });
  const [messages, setMessages] = useState([]);
  const [showSettings, setShowSettings] = useState(false);
  const [relayUrlInput, setRelayUrlInput] = useState('');
  const transcriptRef = useRef(null);

  const conversation = useConversation({
    onConnect: () => console.log('[ElevenLabs] Connected'),
    onDisconnect: () => console.log('[ElevenLabs] Disconnected'),
    onMessage: ({ message, source }) => {
      setMessages((prev) => [...prev, { text: message, source, id: Date.now() + Math.random() }]);
    },
    onError: (err) => {
      console.error('[ElevenLabs] Error:', err);
    },
  });

  useEffect(() => {
    window.electronAPI.getConfig().then((cfg) => {
      setConfig(cfg);
      setRelayUrlInput(cfg.relayUrl || '');
      if (cfg.firstLaunch) setShowSettings(true);
    });
    window.electronAPI.onRelayStatus((status) => {
      setRelayStatus(status);
    });
  }, []);

  // Auto-scroll transcript
  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [messages]);

  const startConversation = async () => {
    if (!config?.agentId) {
      alert('No Agent ID configured. Check your .env file.');
      return;
    }
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
      await conversation.startSession({
        agentId: config.agentId,
        connectionType: 'webrtc',
      });
    } catch (err) {
      console.error('Failed to start conversation:', err);
      alert(`Failed to start: ${err.message}`);
    }
  };

  const stopConversation = () => {
    conversation.endSession();
  };

  const saveRelayUrl = async () => {
    await window.electronAPI.saveRelayUrl(relayUrlInput);
    setShowSettings(false);
  };

  const isActive = conversation.status === 'connected';

  if (showSettings) {
    return (
      <div className="app">
        <header>
          <h1>Settings</h1>
          <button className="icon-btn" onClick={() => setShowSettings(false)}>✕</button>
        </header>
        <main style={{ alignItems: 'stretch', gap: 12 }}>
          <label className="settings-label">
            Relay URL
            <span className="settings-hint">wss://your-tunnel-url.trycloudflare.com/relay</span>
          </label>
          <input
            className="settings-input"
            type="text"
            value={relayUrlInput}
            onChange={(e) => setRelayUrlInput(e.target.value)}
            placeholder="wss://..."
            spellCheck={false}
          />
          <button className="save-btn" onClick={saveRelayUrl}>
            Save & Reconnect
          </button>
          <div className="settings-hint" style={{ marginTop: 8 }}>
            Agent ID: {config?.agentId || '(not set — check .env)'}
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <header>
        <h1>Kolb-Bot</h1>
        <div className="header-right">
          <div className={`relay-dot ${relayStatus.connected ? 'connected' : relayStatus.connecting ? 'connecting' : 'disconnected'}`}>
            {relayStatus.connected ? '● Tools' : relayStatus.connecting ? '◌ Connecting…' : '○ No Tools'}
          </div>
          <button className="icon-btn" onClick={() => setShowSettings(true)} title="Settings">⚙</button>
        </div>
      </header>

      <main>
        {!relayStatus.connected && !relayStatus.connecting && (
          <div className="warning">
            Desktop tools not connected. Open this app on your PC and check the relay URL in settings.
          </div>
        )}

        <div className="talk-area">
          <button
            className={`talk-btn ${isActive ? 'active' : ''}`}
            onClick={isActive ? stopConversation : startConversation}
          >
            {isActive ? 'Stop' : 'Talk'}
          </button>

          <div className="agent-status">
            {isActive
              ? conversation.isSpeaking
                ? 'Agent is speaking…'
                : 'Listening…'
              : conversation.status === 'connecting'
              ? 'Connecting…'
              : ''}
          </div>
        </div>

        <div className="transcript" ref={transcriptRef}>
          {messages.length === 0 && !isActive && (
            <div className="empty-transcript">Press Talk to start a conversation</div>
          )}
          {messages.map((msg) => (
            <div key={msg.id} className={`message ${msg.source}`}>
              <span className="source">{msg.source === 'user' ? 'You' : 'Agent'}</span>
              <span className="text">{msg.text}</span>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
