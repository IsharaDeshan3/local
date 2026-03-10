"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type SimplePeerType from "simple-peer";
import {
  Mic,
  MicOff,
  PhoneOff,
  Copy,
  Check,
  Activity,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface TranscriptLine {
  role: "doctor" | "patient";
  text: string;
  timestamp: number;
}

interface VideoCallModalProps {
  readonly onCallEnd: (mergedTranscript: string) => void;
  readonly onClose: () => void;
}

const POLL_INTERVAL = 1500;

export default function VideoCallModal({ onCallEnd, onClose }: VideoCallModalProps) {
  const [callId, setCallId] = useState<string | null>(null);
  const [joinUrl, setJoinUrl] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const [connectionState, setConnectionState] = useState<
    "creating" | "waiting" | "connecting" | "connected" | "ended"
  >("creating");

  const [transcriptLines, setTranscriptLines] = useState<TranscriptLine[]>([]);
  const [isListening, setIsListening] = useState(false);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [currentDoctorText, setCurrentDoctorText] = useState("");

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const peerRef = useRef<SimplePeerType.Instance | null>(null);
  const pollRef = useRef<NodeJS.Timeout | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const transcriptRef = useRef<TranscriptLine[]>([]);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  // Keep transcriptRef in sync
  useEffect(() => {
    transcriptRef.current = transcriptLines;
  }, [transcriptLines]);

  // Auto-scroll transcript
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcriptLines]);

  // Attach remote stream
  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  useEffect(() => {
    if (connectionState === "connected" && remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [connectionState, remoteStream]);

  // Create call on mount
  useEffect(() => {
    createCall();
    return () => {
      cleanupAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function cleanupAll() {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    if (peerRef.current) {
      try { peerRef.current.destroy(); } catch { }
      peerRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    stopRecognition();
  }

  // --- Simple Speech Recognition (NO auto-restart to avoid crashes) ---
  function startRecognition() {
    // Get the constructor
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      toast.error("Speech recognition not supported — use Chrome or Edge");
      return;
    }

    // Stop any existing instance first
    stopRecognition();

    try {
      const rec = new SR() as SpeechRecognition;
      rec.lang = "si-LK";
      rec.continuous = true;
      rec.interimResults = true;

      let accumulated = "";

      rec.onresult = (event: SpeechRecognitionEvent) => {
        let interim = "";
        let newFinal = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const txt = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            newFinal += txt;
          } else {
            interim += txt;
          }
        }

        if (newFinal) {
          accumulated += (accumulated ? " " : "") + newFinal.trim();
          const full = accumulated.trim();
          if (full) {
            setTranscriptLines((prev) => {
              const last = prev[prev.length - 1];
              if (last && last.role === "doctor" && Date.now() - last.timestamp < 30000) {
                return [...prev.slice(0, -1), { ...last, text: full, timestamp: Date.now() }];
              }
              return [...prev, { role: "doctor", text: full, timestamp: Date.now() }];
            });
          }
        }
        setCurrentDoctorText(interim);
      };

      rec.onerror = (e: SpeechRecognitionErrorEvent) => {
        console.warn("Doctor SR error:", e.error);
        // Don't crash — just stop cleanly
        if (e.error === "not-allowed") {
          toast.error("Microphone access denied for speech recognition");
          stopRecognition();
        }
      };

      rec.onend = () => {
        // NO auto-restart — just toggle the mic state so user can manually restart
        console.log("Doctor SR ended naturally");
        setIsListening(false);
        setCurrentDoctorText("");
      };

      rec.start();
      recognitionRef.current = rec;
      setIsListening(true);
      toast.success("🎤 Doctor speech recognition active");
      console.log("Doctor SR started successfully");
    } catch (err: any) {
      console.error("Failed to start Doctor SR:", err);
      toast.error("Failed to start speech recognition: " + (err?.message || err));
    }
  }

  function stopRecognition() {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.onend = null;
        recognitionRef.current.onerror = null;
        recognitionRef.current.onresult = null;
        recognitionRef.current.abort();
      } catch { }
      recognitionRef.current = null;
    }
    setIsListening(false);
    setCurrentDoctorText("");
  }

  async function createCall() {
    try {
      const SimplePeer = (await import("simple-peer")).default;

      const res = await fetch("/api/call/create", { method: "POST" });
      const data = await res.json();
      setCallId(data.callId);
      setJoinUrl(data.joinUrl);
      setConnectionState("waiting");

      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      streamRef.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }

      const peer = new SimplePeer({ initiator: true, trickle: true, stream });

      peer.on("signal", async (sig: unknown) => {
        await fetch("/api/call/signal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ callId: data.callId, role: "doctor", signal: sig }),
        });
      });

      peer.on("stream", (s: MediaStream) => setRemoteStream(s));

      peer.on("connect", () => {
        setConnectionState("connected");
        toast.success("Patient connected!");
        // Start speech recognition directly
        startRecognition();
      });

      peer.on("data", (rawData: Buffer | string) => {
        try {
          const msg = JSON.parse(rawData.toString());
          if (msg.type === "transcript" && msg.text) {
            setTranscriptLines((prev) => {
              const last = prev[prev.length - 1];
              if (last && last.role === "patient" && Date.now() - last.timestamp < 30000) {
                return [...prev.slice(0, -1), { ...last, text: msg.text, timestamp: Date.now() }];
              }
              return [...prev, { role: "patient", text: msg.text, timestamp: Date.now() }];
            });
          }
        } catch { }
      });

      peer.on("close", () => {
        setConnectionState("ended");
        stopRecognition();
      });

      peer.on("error", (err: Error) => {
        console.error("Peer error:", err);
        toast.error("Connection error: " + err.message);
      });

      peerRef.current = peer;

      // Poll for patient signals
      pollRef.current = setInterval(async () => {
        try {
          const r = await fetch(`/api/call/signal?callId=${data.callId}&role=doctor`);
          const { signals } = await r.json();
          if (signals?.length > 0) {
            setConnectionState((prev) => (prev === "waiting" ? "connecting" : prev));
            for (const s of signals) peer.signal(s);
          }
        } catch { }
      }, POLL_INTERVAL);
    } catch (error: any) {
      console.error("Failed to create call:", error);
      toast.error("Failed to create video call: " + (error?.message || error));
    }
  }

  const copyUrl = async () => {
    await navigator.clipboard.writeText(joinUrl);
    setCopied(true);
    toast.success("Join URL copied!");
    setTimeout(() => setCopied(false), 2000);
  };

  const endCall = () => {
    const merged = transcriptRef.current.map((l) => `${l.role}: ${l.text}`).join("\n");
    cleanupAll();
    setConnectionState("ended");
    onCallEnd(merged);
  };

  const remoteVideoCallbackRef = useCallback(
    (node: HTMLVideoElement | null) => {
      (remoteVideoRef as React.MutableRefObject<HTMLVideoElement | null>).current = node;
      if (node && remoteStream) node.srcObject = remoteStream;
    },
    [remoteStream]
  );

  return (
    <div className="fixed inset-0 z-50 bg-background/95 backdrop-blur-xl flex flex-col animate-in fade-in duration-300">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
        <div className="flex items-center gap-3">
          <div className={`h-3 w-3 rounded-full ${connectionState === "connected" ? "bg-emerald-500 animate-pulse"
            : connectionState === "connecting" ? "bg-yellow-500 animate-pulse"
              : connectionState === "ended" ? "bg-red-500"
                : "bg-white/20"
            }`} />
          <h2 className="text-sm font-black uppercase tracking-widest">
            {connectionState === "creating" && "Initializing..."}
            {connectionState === "waiting" && "Waiting for Patient"}
            {connectionState === "connecting" && "Connecting..."}
            {connectionState === "connected" && "Video Call Active"}
            {connectionState === "ended" && "Call Ended"}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          {connectionState === "connected" && (
            <Button
              onClick={() => isListening ? stopRecognition() : startRecognition()}
              variant="outline"
              className={`h-9 px-4 rounded-lg text-xs font-bold border ${isListening
                ? "border-emerald-500/30 text-emerald-400 bg-emerald-500/10"
                : "border-white/10 text-muted-foreground"
                }`}
            >
              {isListening ? <Mic className="h-3.5 w-3.5 mr-1.5" /> : <MicOff className="h-3.5 w-3.5 mr-1.5" />}
              {isListening ? "Listening (si)" : "Mic Off — Click to Start"}
            </Button>
          )}
          {(connectionState === "connected" || connectionState === "waiting" || connectionState === "connecting") && (
            <Button onClick={endCall} className="h-9 px-5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-bold">
              <PhoneOff className="h-3.5 w-3.5 mr-1.5" /> End Call
            </Button>
          )}
          {connectionState === "ended" && (
            <Button onClick={onClose} variant="outline" className="h-9 px-4 rounded-lg text-xs font-bold border-white/10">
              Close
            </Button>
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex gap-4 p-4 min-h-0">
        <div className="flex-1 flex flex-col gap-3 min-w-0">
          {(connectionState === "waiting" || connectionState === "connecting") && joinUrl && (
            <div className="glass rounded-xl p-4 border border-primary/20 bg-primary/5">
              <p className="text-[10px] font-black uppercase tracking-widest text-primary mb-2">Send this URL to the patient</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs font-mono text-foreground/80 bg-black/30 p-3 rounded-lg overflow-x-auto whitespace-nowrap">{joinUrl}</code>
                <Button onClick={copyUrl} size="sm" className="h-9 px-4 rounded-lg text-xs font-bold shrink-0">
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </Button>
              </div>
            </div>
          )}

          <div className="flex-1 grid grid-cols-2 gap-3 min-h-0">
            <div className="relative rounded-xl overflow-hidden bg-black/40 border border-white/10">
              <video ref={localVideoRef} autoPlay muted playsInline className="w-full h-full object-cover" />
              <div className="absolute bottom-2 left-2 px-2 py-1 rounded-md bg-black/60 text-[9px] font-bold text-white uppercase tracking-wider">You (Doctor)</div>
              {isListening && (
                <div className="absolute top-2 right-2 px-2 py-1 rounded-md bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 text-[9px] font-bold flex items-center gap-1 animate-pulse">
                  <Mic className="h-3 w-3" /> Listening
                </div>
              )}
            </div>
            <div className="relative rounded-xl overflow-hidden bg-black/40 border border-white/10">
              <video ref={remoteVideoCallbackRef} autoPlay playsInline className={`w-full h-full object-cover ${!remoteStream ? "hidden" : ""}`} />
              {!remoteStream && (
                <div className="w-full h-full flex items-center justify-center absolute inset-0">
                  {connectionState === "waiting" ? (
                    <div className="text-center"><Loader2 className="h-10 w-10 text-primary/30 animate-spin mx-auto mb-3" /><p className="text-xs text-muted-foreground font-bold">Waiting for patient...</p></div>
                  ) : connectionState === "connecting" ? (
                    <div className="text-center"><Activity className="h-10 w-10 text-yellow-400/50 animate-pulse mx-auto mb-3" /><p className="text-xs text-muted-foreground font-bold">Connecting...</p></div>
                  ) : connectionState === "connected" ? (
                    <div className="text-center"><Loader2 className="h-10 w-10 text-primary/30 animate-spin mx-auto mb-3" /><p className="text-xs text-muted-foreground font-bold">Loading stream...</p></div>
                  ) : null}
                </div>
              )}
              <div className="absolute bottom-2 left-2 px-2 py-1 rounded-md bg-black/60 text-[9px] font-bold text-white uppercase tracking-wider">Patient</div>
            </div>
          </div>

          {currentDoctorText && (
            <div className="glass rounded-lg p-3 border border-white/10">
              <p className="text-[9px] font-bold text-white/40 uppercase tracking-widest mb-1">You are saying...</p>
              <p className="text-xs text-foreground/60 italic">{currentDoctorText}</p>
            </div>
          )}
        </div>

        {/* Transcript Panel */}
        <div className="w-80 flex flex-col glass rounded-xl border border-white/10 shrink-0">
          <div className="px-4 py-3 border-b border-white/10">
            <h3 className="text-[10px] font-black uppercase tracking-widest text-primary">Live Transcription</h3>
            <p className="text-[9px] text-muted-foreground mt-0.5">{transcriptLines.length} entries</p>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-0">
            {transcriptLines.length === 0 ? (
              <div className="h-full flex items-center justify-center">
                <p className="text-[10px] text-muted-foreground/40 italic text-center">
                  Speak in Sinhala to see<br />transcription here...
                </p>
              </div>
            ) : (
              transcriptLines.map((line, i) => (
                <div key={i} className={`p-2.5 rounded-lg text-xs ${line.role === "doctor" ? "bg-primary/10 border border-primary/20 ml-2" : "bg-violet-500/10 border border-violet-500/20 mr-2"
                  }`}>
                  <span className={`text-[9px] font-black uppercase tracking-widest ${line.role === "doctor" ? "text-primary" : "text-violet-400"}`}>
                    {line.role}:
                  </span>
                  <p className="text-foreground/80 mt-1 leading-relaxed">{line.text}</p>
                </div>
              ))
            )}
            <div ref={transcriptEndRef} />
          </div>
        </div>
      </div>
    </div>
  );
}
