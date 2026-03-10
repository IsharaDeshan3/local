"use client";

import { useState, useEffect, useRef } from "react";
import SpeechRecognition, {
  useSpeechRecognition,
} from "react-speech-recognition";
import {
  Mic,
  MicOff,
  Activity,
  AlertCircle,
  History,
  Check,
  Shield,
  Edit3,
  Heart,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import ApprovalEditor, { CurrentState, SymptomData } from "./ApprovalEditor";

interface NlpProcessorProps {
  readonly onUpdateSummary: (extractedData: any) => void;
  readonly currentState: CurrentState;
  readonly onCurrentStateChange: (s: CurrentState) => void;
}

interface BackendResponse {
  updated_state: CurrentState;
  missing_critical: {
    symptoms: string[];
    risk_factors: string[];
  };
  translated_text: string;
}

const BACKEND_URL = "http://localhost:8001";

export default function NlpProcessor({
  onUpdateSummary,
  currentState,
  onCurrentStateChange,
}: NlpProcessorProps) {
  const [sessionId] = useState(`session_${Date.now()}`);
  const [backendResponse, setBackendResponse] =
    useState<BackendResponse | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [lastTranslated, setLastTranslated] = useState("");
  const [showEditor, setShowEditor] = useState(false);

  const {
    transcript,
    listening,
    resetTranscript,
    browserSupportsSpeechRecognition,
  } = useSpeechRecognition();

  const delayTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Function to approve an item inline
  const approveItem = (category: keyof CurrentState, key: string) => {
    onCurrentStateChange({
      ...currentState,
      [category]: {
        ...currentState[category],
        [key]: {
          ...currentState[category][key],
          status: "approved",
        },
      },
    });
  };

  // Send transcript to backend
  const sendTranscript = async (transcriptText: string) => {
    if (!transcriptText.trim()) return;

    setIsProcessing(true);
    try {
      const response = await fetch(`${BACKEND_URL}/process-transcript`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session_id: sessionId,
          transcript_si: transcriptText,
          current_state: currentState,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to process transcript");
      }

      const data: BackendResponse = await response.json();
      setBackendResponse(data);
      onCurrentStateChange(data.updated_state);
      setLastTranslated(data.translated_text);
      onUpdateSummary(data);
      resetTranscript();
    } catch (error) {
      console.error("Error processing transcript:", error);
      toast.error("Extraction Synthesis Refused");
    } finally {
      setIsProcessing(false);
    }
  };

  // Schedule API call with delay
  const scheduleApiCall = (transcriptText: string) => {
    if (delayTimerRef.current) {
      clearTimeout(delayTimerRef.current);
    }
    delayTimerRef.current = setTimeout(() => {
      sendTranscript(transcriptText);
    }, 5000);
  };

  // Handle when listening starts
  useEffect(() => {
    if (listening) {
      resetTranscript();
      const timer = setTimeout(() => {
        if (transcript) {
          scheduleApiCall(transcript);
        }
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [listening]);

  // Handle when listening stops
  const handleStopListening = () => {
    SpeechRecognition.stopListening();
    if (transcript) {
      scheduleApiCall(transcript);
    }
  };

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (delayTimerRef.current) {
        clearTimeout(delayTimerRef.current);
      }
    };
  }, []);

  const toggleListening = () => {
    if (listening) {
      handleStopListening();
    } else {
      SpeechRecognition.startListening({
        continuous: true,
        language: "si-LK",
      });
      toast.info("Neural Gateway Active: Capturing Sinhala Stream");
    }
  };

  // Helper to count items in a category
  const countItems = (items: Record<string, SymptomData>) =>
    Object.keys(items).length;
  const countPending = (items: Record<string, SymptomData>) =>
    Object.values(items).filter((v) => v.status !== "approved").length;
  const countApproved = (items: Record<string, SymptomData>) =>
    Object.values(items).filter((v) => v.status === "approved").length;

  // Extract approved items as arrays for summary
  const getApprovedSummary = (state: CurrentState) => ({
    symptoms: Object.values(state.symptoms)
      .filter((v) => v.status === "approved")
      .map((v) => v.value),
    medical_history: Object.values(state.medical_history)
      .filter((v) => v.status === "approved")
      .map((v) => v.value),
    allergies: Object.values(state.allergies)
      .filter((v) => v.status === "approved")
      .map((v) => v.value),
    risk_factors: Object.values(state.risk_factors)
      .filter((v) => v.status === "approved")
      .map((v) => v.value),
  });

  // Handle save from ApprovalEditor
  const handleSaveAndClose = (finalState: CurrentState) => {
    onCurrentStateChange(finalState);
    const summary = getApprovedSummary(finalState);
    onUpdateSummary({ updated_state: finalState, summary });
    try {
      localStorage.setItem("nlp.currentState", JSON.stringify(finalState));
      localStorage.setItem("nlp.summary", JSON.stringify(summary));
    } catch {}
    setShowEditor(false);
  };

  if (!browserSupportsSpeechRecognition) {
    return (
      <div className="p-10 glass rounded-[2rem] text-center border-destructive/20 text-destructive underline">
        Critical: Browser Architecture lacks Neural Audio API Support.
      </div>
    );
  }

  return (
    <>
      {showEditor ? (
        // Full-screen Editor View (replaces main content)
        <div className="animate-in fade-in duration-300">
          <ApprovalEditor
            sessionId={sessionId}
            initialState={currentState}
            onStateChange={(next) => {
              onCurrentStateChange(next);
              try {
                localStorage.setItem("nlp.currentState", JSON.stringify(next));
              } catch {}
            }}
            onSave={handleSaveAndClose}
            onClose={() => setShowEditor(false)}
          />
        </div>
      ) : (
        // Main NLP Processor View
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 animate-in fade-in duration-700">
          {/* 🎙️ NEURAL GATEWAY / RECORDER */}
          <div className="flex flex-col gap-3">
            <div
              className={`relative glass rounded-xl p-4 flex flex-col items-center justify-center text-center transition-all duration-1000 border-2 ${
                listening
                  ? "border-primary/40 shadow-[0_0_50px_rgba(var(--primary-rgb),0.1)]"
                  : "border-white/5"
              }`}
            >
              {/* Pulsing Core */}
              <div
                className={`h-14 w-14 rounded-full flex-center mb-3 relative ${
                  listening ? "bg-primary/20 animate-pulse" : "bg-white/5"
                }`}
              >
                {listening && (
                  <>
                    <div className="absolute inset-0 rounded-full border-2 border-primary animate-ping opacity-20"></div>
                    <div className="absolute -inset-4 rounded-full border border-primary/10 animate-pulse"></div>
                  </>
                )}
                {listening ? (
                  <Mic className="h-6 w-6 text-primary" />
                ) : (
                  <MicOff className="h-6 w-6 text-muted-foreground opacity-20" />
                )}
              </div>

              <h3 className="text-sm font-black tracking-tight mb-0.5">
                {listening
                  ? "Capturing Voice..."
                  : "AI Voice Recognition is Active"}
              </h3>
              <p className="text-[9px] text-muted-foreground uppercase tracking-widest font-bold opacity-60 mb-3 max-w-[220px]">
                {listening
                  ? "Listening to patient conversation in Sinhala"
                  : "Tap the button below to start capturing"}
              </p>

              <Button
                onClick={toggleListening}
                disabled={isProcessing}
                className={`h-10 px-6 rounded-lg font-black uppercase tracking-[0.12em] transition-all text-xs ${
                  listening
                    ? "bg-destructive/10 text-destructive border-2 border-destructive/20 hover:bg-destructive/20"
                    : "bg-primary text-primary-foreground shadow-lg glow-primary border-none hover:scale-105"
                }`}
              >
                {listening ? "Stop Capture" : "Start Voice Capture"}
              </Button>

              {isProcessing && (
                <div className="absolute bottom-3 flex items-center gap-2 text-[9px] font-black text-primary animate-pulse">
                  <Activity className="h-3 w-3" /> Processing voice input...
                </div>
              )}
            </div>

            {/* Translation Preview - Hidden from users */}

            {/* Missing Critical Information */}
            {backendResponse &&
              (backendResponse.missing_critical.symptoms?.length > 0 ||
                backendResponse.missing_critical.risk_factors?.length > 0) && (
                <div className="rounded-2xl overflow-hidden border-2 border-red-500/40 bg-gradient-to-br from-red-950/60 to-red-900/30 shadow-lg shadow-red-900/20 animate-in slide-in-from-bottom-3 duration-500">
                  {/* Header bar */}
                  <div className="flex items-center gap-3 px-4 py-3 bg-red-500/20 border-b border-red-500/30">
                    <div className="h-8 w-8 rounded-lg bg-red-500/30 flex items-center justify-center shrink-0">
                      <AlertCircle className="h-5 w-5 text-red-400" />
                    </div>
                    <div>
                      <p className="text-sm font-black text-red-300 uppercase tracking-widest leading-none">
                        Missing Critical Information
                      </p>
                      <p className="text-[10px] text-red-400/70 mt-0.5">
                        Doctor should ask the patient about these items
                      </p>
                    </div>
                    <div className="ml-auto flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-red-500/20 border border-red-500/30">
                      <span className="h-2 w-2 rounded-full bg-red-400 animate-pulse" />
                      <span className="text-[10px] font-black text-red-300 uppercase tracking-wider">
                        {(backendResponse.missing_critical.symptoms?.length ??
                          0) +
                          (backendResponse.missing_critical.risk_factors
                            ?.length ?? 0)}{" "}
                        items
                      </span>
                    </div>
                  </div>

                  <div className="p-4 space-y-4">
                    {backendResponse.missing_critical.symptoms?.length > 0 && (
                      <div>
                        <p className="text-[10px] font-black text-red-300/80 uppercase tracking-widest mb-2 flex items-center gap-1.5">
                          <span className="h-1.5 w-1.5 rounded-full bg-red-400 inline-block" />
                          Symptoms to Clarify
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {backendResponse.missing_critical.symptoms.map(
                            (s) => (
                              <span
                                key={s}
                                className="px-3 py-1.5 rounded-xl bg-red-500/15 text-red-300 text-xs font-bold border border-red-500/30 hover:bg-red-500/25 transition-colors"
                              >
                                {s}
                              </span>
                            ),
                          )}
                        </div>
                      </div>
                    )}

                    {backendResponse.missing_critical.risk_factors?.length >
                      0 && (
                      <div>
                        <p className="text-[10px] font-black text-orange-300/80 uppercase tracking-widest mb-2 flex items-center gap-1.5">
                          <span className="h-1.5 w-1.5 rounded-full bg-orange-400 inline-block" />
                          Risk Factors to Verify
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {backendResponse.missing_critical.risk_factors.map(
                            (r) => (
                              <span
                                key={r}
                                className="px-3 py-1.5 rounded-xl bg-orange-500/15 text-orange-300 text-xs font-bold border border-orange-500/30 hover:bg-orange-500/25 transition-colors"
                              >
                                {r}
                              </span>
                            ),
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
          </div>

          {/* 📊 EXTRACTED DATA PANEL */}
          <div className="space-y-1">
            {/* Identified Symptoms */}
            <Card className="glass border-white/5 bg-white/[0.02] rounded-[2rem] shadow-xl overflow-hidden hover:border-primary/20 transition-all duration-500">
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <div className="h-8 w-8 rounded-lg bg-orange-500/10 flex-center text-orange-500">
                      <AlertCircle className="h-4 w-4" />
                    </div>
                    <h4 className="text-sm font-black uppercase tracking-widest">
                      Active Symptoms
                    </h4>
                  </div>
                  <div className="flex items-center gap-2">
                    {countPending(currentState.symptoms) > 0 && (
                      <span className="text-[9px] font-bold text-yellow-400 px-2 py-0.5 bg-yellow-500/10 rounded-lg">
                        {countPending(currentState.symptoms)} pending
                      </span>
                    )}
                    <div className="text-[10px] font-bold text-muted-foreground px-2 py-1 bg-white/5 rounded-lg uppercase">
                      {countApproved(currentState.symptoms)} approved
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  {countItems(currentState.symptoms) > 0 ? (
                    Object.entries(currentState.symptoms).map(([key, data]) => (
                      <button
                        key={key}
                        type="button"
                        className={`px-3 py-1 rounded-lg text-[10px] font-black border animate-in zoom-in-95 duration-300 flex items-center gap-1.5 ${
                          data.status === "approved"
                            ? "bg-orange-500/5 text-orange-400 border-orange-500/10"
                            : "bg-yellow-500/10 text-yellow-400 border-yellow-500/20 cursor-pointer hover:bg-yellow-500/20"
                        }`}
                        onClick={() =>
                          data.status !== "approved" &&
                          approveItem("symptoms", key)
                        }
                        disabled={data.status === "approved"}
                      >
                        {data.status === "approved" ? (
                          <Check className="h-3 w-3" />
                        ) : (
                          <span className="text-[8px]">⏳</span>
                        )}
                        {data.value.toUpperCase()}
                      </button>
                    ))
                  ) : (
                    <p className="text-[10px] italic text-muted-foreground/30 py-2">
                      Awaiting symptom extraction from stream...
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Medical History */}
            <Card className="glass border-white/5 bg-white/[0.02] rounded-[2rem] shadow-xl overflow-hidden hover:border-primary/20 transition-all duration-500">
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <div className="h-8 w-8 rounded-lg bg-blue-500/10 flex-center text-blue-500">
                      <History className="h-4 w-4" />
                    </div>
                    <h4 className="text-sm font-black uppercase tracking-widest">
                      Medical History
                    </h4>
                  </div>
                  {countItems(currentState.medical_history) > 0 && (
                    <div className="text-[10px] font-bold text-muted-foreground px-2 py-1 bg-white/5 rounded-lg uppercase">
                      {countApproved(currentState.medical_history)} items
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap gap-2">
                  {countItems(currentState.medical_history) > 0 ? (
                    Object.entries(currentState.medical_history).map(
                      ([key, data]) => (
                        <button
                          key={key}
                          type="button"
                          className={`px-3 py-1 rounded-lg text-[10px] font-black border animate-in zoom-in-95 duration-300 flex items-center gap-1.5 ${
                            data.status === "approved"
                              ? "bg-blue-500/5 text-blue-400 border-blue-500/10"
                              : "bg-yellow-500/10 text-yellow-400 border-yellow-500/20 cursor-pointer hover:bg-yellow-500/20"
                          }`}
                          onClick={() =>
                            data.status !== "approved" &&
                            approveItem("medical_history", key)
                          }
                          disabled={data.status === "approved"}
                        >
                          {data.status === "approved" ? (
                            <Check className="h-3 w-3" />
                          ) : (
                            <span className="text-[8px]">⏳</span>
                          )}
                          {data.value.toUpperCase()}
                        </button>
                      ),
                    )
                  ) : (
                    <p className="text-[10px] italic text-muted-foreground/30 py-2">
                      No medical history captured yet.
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Allergies */}
            <Card className="glass border-white/5 bg-white/[0.02] rounded-[2rem] shadow-xl overflow-hidden hover:border-primary/20 transition-all duration-500">
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <div className="h-8 w-8 rounded-lg bg-red-500/10 flex-center text-red-500">
                      <Heart className="h-4 w-4" />
                    </div>
                    <h4 className="text-sm font-black uppercase tracking-widest">
                      Allergies
                    </h4>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  {countItems(currentState.allergies) > 0 ? (
                    Object.entries(currentState.allergies).map(
                      ([key, data]) => (
                        <button
                          key={key}
                          type="button"
                          className={`px-3 py-1 rounded-lg text-[10px] font-black border animate-in zoom-in-95 duration-300 flex items-center gap-1.5 ${
                            data.status === "approved"
                              ? "bg-red-500/5 text-red-400 border-red-500/10"
                              : "bg-yellow-500/10 text-yellow-400 border-yellow-500/20 cursor-pointer hover:bg-yellow-500/20"
                          }`}
                          onClick={() =>
                            data.status !== "approved" &&
                            approveItem("allergies", key)
                          }
                          disabled={data.status === "approved"}
                        >
                          {data.status === "approved" ? (
                            <Check className="h-3 w-3" />
                          ) : (
                            <span className="text-[8px]">⏳</span>
                          )}
                          {data.value.toUpperCase()}
                        </button>
                      ),
                    )
                  ) : (
                    <p className="text-[10px] italic text-muted-foreground/30 py-2">
                      No allergies identified.
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Risk Factors */}
            <Card className="glass border-white/5 bg-white/[0.02] rounded-[2rem] shadow-xl overflow-hidden hover:border-primary/20 transition-all duration-500">
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <div className="h-8 w-8 rounded-lg bg-primary/10 flex-center text-primary">
                      <Shield className="h-4 w-4" />
                    </div>
                    <h4 className="text-sm font-black uppercase tracking-widest">
                      Cardiac Risk Factors
                    </h4>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  {countItems(currentState.risk_factors) > 0 ? (
                    Object.entries(currentState.risk_factors).map(
                      ([key, data]) => (
                        <button
                          key={key}
                          type="button"
                          className={`px-3 py-1 rounded-lg text-[10px] font-black border animate-in zoom-in-95 duration-300 flex items-center gap-1.5 ${
                            data.status === "approved"
                              ? "bg-primary/5 text-primary border-primary/10"
                              : "bg-yellow-500/10 text-yellow-400 border-yellow-500/20 cursor-pointer hover:bg-yellow-500/20"
                          }`}
                          onClick={() =>
                            data.status !== "approved" &&
                            approveItem("risk_factors", key)
                          }
                          disabled={data.status === "approved"}
                        >
                          {data.status === "approved" ? (
                            <Check className="h-3 w-3" />
                          ) : (
                            <span className="text-[8px]">⏳</span>
                          )}
                          {data.value.toUpperCase()}
                        </button>
                      ),
                    )
                  ) : (
                    <p className="text-[10px] italic text-muted-foreground/30 py-2">
                      No risk factors identified in current context.
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Edit/Review Button */}
            <Button
              onClick={() => {
                try {
                  localStorage.setItem("nlp.sessionId", sessionId);
                  localStorage.setItem(
                    "nlp.currentState",
                    JSON.stringify(currentState),
                  );
                } catch (e) {
                  console.error("Failed to persist to localStorage", e);
                }
                setShowEditor(true);
              }}
              className="w-full h-10 rounded-xl font-black uppercase tracking-wider text-xs mt-2 bg-indigo-600 hover:bg-indigo-700"
            >
              <Edit3 className="h-4 w-4 mr-2" />
              Review & Edit Extracted Data
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
