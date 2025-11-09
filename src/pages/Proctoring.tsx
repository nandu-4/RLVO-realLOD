import { useState, useEffect, useRef } from "react";
import { Video, AlertTriangle, CheckCircle, Download, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import Navigation from "@/components/Navigation";
import { supabase } from "@/integrations/supabase/client";
import { ProctoringSystem, ProctoringStatus } from "@/lib/ProctoringSystem";

const Proctoring = () => {
  // --- STATE FOR UI (Updated by slow loop) ---
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [headCount, setHeadCount] = useState(0);
  const [headTurns, setHeadTurns] = useState(0);
  const [gazeDeviations, setGazeDeviations] = useState(0);
  const [handDetections, setHandDetections] = useState(0);
  const [criticalAnomaliesCount, setCriticalAnomaliesCount] = useState(0);
  const [alerts, setAlerts] = useState<Array<{ time: string; type: string; message: string }>>([]);
  const [sessionTime, setSessionTime] = useState(0);
  const [currentStatus, setCurrentStatus] = useState<ProctoringStatus | null>(null);
  const [isInitializing, setIsInitializing] = useState(false);
  const [isMediaPipeReady, setIsMediaPipeReady] = useState(false);
  
  // --- REFS FOR HIGH-SPEED LOOPS & STATE ---
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const proctorSystemRef = useRef<ProctoringSystem | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  
  // Refs for the new UI update logic
  const latestStatusRef = useRef<ProctoringStatus | null>(null); // For the slow loop to read
  const lastUiStatusRef = useRef<ProctoringStatus | null>(null); // To compare and find *new* events

  // --- HIGH-SPEED DETECTION LOOP (60 FPS) ---
  // This loop ONLY runs detection and stores the result in latestStatusRef.
  // It does NOT call any setState functions.
  const processFrameLoop = (timestamp: number) => { 
    if (!isMonitoring) return; // Stop loop if monitoring ended

    const video = videoRef.current;
    const proctoringSystem = proctorSystemRef.current;

    // Guard clause
    if (!isMediaPipeReady || !proctoringSystem || !video || video.readyState < 2) {
      animationFrameRef.current = requestAnimationFrame(processFrameLoop);
      return;
    }

    // Process the frame
    try {
      const status = proctoringSystem.processFrame(video, timestamp);
      // Store the latest status for the slow loop
      latestStatusRef.current = status;
    } catch (e) {
      console.error("Error in detection loop:", e);
    }

    // Continue the loop
    animationFrameRef.current = requestAnimationFrame(processFrameLoop);
  };

  // --- LOW-SPEED UI UPDATE LOOP (2 FPS) ---
  // This loop reads from latestStatusRef and calls setState
  // to update the UI safely.
  useEffect(() => {
    let uiUpdateInterval: NodeJS.Timeout;

    if (isMonitoring) {
      uiUpdateInterval = setInterval(() => {
        const status = latestStatusRef.current;
        if (!status) return; // No status yet

        const lastStatus = lastUiStatusRef.current;

        // 1. Update the main status text and head count
        setCurrentStatus(status);
        setHeadCount(status.debugScores.headCount || 0);

        // 2. Check for *new* anomaly events
        // We compare the *current* causes with the *previous* causes
        const newCauses = new Set(status.causes);
        const oldCauses = new Set(lastStatus?.causes || []);

        const checkNewAnomaly = (cause: string, stateUpdater: React.Dispatch<React.SetStateAction<number>>) => {
          if (newCauses.has(cause) && !oldCauses.has(cause)) {
            // This anomaly *just* started
            stateUpdater(prev => prev + 1);
          }
        };

        checkNewAnomaly('Head Deviation (H)', setHeadTurns);
        checkNewAnomaly('Head Deviation (V)', setHeadTurns);
        checkNewAnomaly('Gaze Shift', setGazeDeviations);
        checkNewAnomaly('Hand Proximity', setHandDetections);
        
        // 3. Check for *new* critical events
        if (status.isCritical && !lastStatus?.isCritical) {
          // This critical event *just* started
          setCriticalAnomaliesCount(prev => prev + 1);
          
          const primaryCause = status.causes[0] || 'Unknown';
          const duration = proctorSystemRef.current?.getAnomalyDuration() || 0;

          // Log to server immediately
          supabase.functions.invoke('log-anomaly', {
            body: {
              cause: primaryCause,
              duration: duration,
              timestamp: new Date().toISOString()
            }
          }).catch(err => console.error('Failed to log anomaly:', err));

          // Add critical alert to UI
          const alert = {
            time: new Date().toLocaleTimeString(),
            type: "critical",
            message: `CRITICAL: ${primaryCause} for ${Math.round(duration)}s`
          };
          setAlerts(prev => [alert, ...prev].slice(0, 15));
          toast.error(`Critical violation: ${primaryCause}`);
        }
        
        // 4. Add non-critical warning alerts (throttled)
        if (status.isAnomalous && !status.isCritical && !lastStatus?.isAnomalous) {
           const alert = {
            time: new Date().toLocaleTimeString(),
            type: "warning",
            message: `WARNING: ${status.causes[0]}`
          };
          setAlerts(prev => [alert, ...prev].slice(0, 15));
        }

        // 5. Store the current status as the "last" status for the next check
        lastUiStatusRef.current = status;

      }, 500); // Update UI every 500ms (2 FPS)
    }
    
    return () => {
      if (uiUpdateInterval) clearInterval(uiUpdateInterval);
    }
  }, [isMonitoring]);

  // Session Timer
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isMonitoring) {
      interval = setInterval(() => {
        setSessionTime(prev => prev + 1);
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [isMonitoring]);

  // General Cleanup
  useEffect(() => {
    return () => {
      // Stop webcam
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
      // Stop detection loop
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      // Clean up models
      if (proctorSystemRef.current) {
        proctorSystemRef.current.destroy();
      }
    };
  }, []);

  const startMonitoring = async () => {
    try {
      setIsInitializing(true);
      
      // 1. Initialize ProctoringSystem
      if (!proctorSystemRef.current || !isMediaPipeReady) {
        const system = new ProctoringSystem();
        toast.info("Initializing MediaPipe models...");
        await system.initialize();
        proctorSystemRef.current = system;
        setIsMediaPipeReady(true);
        toast.success("Models loaded successfully");
      }

      // 2. Get webcam stream
      toast.info("Requesting camera access...");
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { width: 1280, height: 720 } 
      });
      
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        streamRef.current = stream;

        // 3. Wait for video to be ready
        await new Promise<void>((resolve) => {
          const checkReady = () => {
            if (videoRef.current && videoRef.current.readyState >= 2) {
              resolve();
            } else {
              setTimeout(checkReady, 100);
            }
          };
          checkReady();
        });
      }

      // 4. Reset state and start monitoring
      setIsMonitoring(true);
      setHeadCount(0);
      setHeadTurns(0);
      setGazeDeviations(0);
      setHandDetections(0);
      setCriticalAnomaliesCount(0);
      latestStatusRef.current = null;
      lastUiStatusRef.current = null;
      setAlerts([{
        time: new Date().toLocaleTimeString(),
        type: "success",
        message: "Proctoring session started - Client-side processing active"
      }]);
      setSessionTime(0);
      proctorSystemRef.current?.reset(); // Reset timers in the engine
      
      // 5. Start the high-speed detection loop
      animationFrameRef.current = requestAnimationFrame(processFrameLoop);
      
      setIsInitializing(false);
      toast.success("Proctoring started - Processing locally");
    } catch (error) {
      console.error('Error starting monitoring:', error);
      setIsInitializing(false);
      setIsMediaPipeReady(false);
      toast.error("Failed to start proctoring. Please check camera permissions.");
    }
  };

  const stopMonitoring = () => {
    setIsMonitoring(false); // This will stop both loops

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    
    // animationFrameRef is stopped by the check in processFrameLoop
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setCurrentStatus(null);
    setAlerts(prev => [{
      time: new Date().toLocaleTimeString(),
      type: "info",
      message: "Proctoring session ended"
    }, ...prev]);
    toast.info("Proctoring session ended");
  };

  // This is the "Test Detection" button
  const testDetection = () => {
    const video = videoRef.current;
    const system = proctorSystemRef.current;
    if (video && system && video.readyState >= 2) {
      // Use performance.now() for a valid timestamp
      const status = system.processFrame(video, performance.now());
      console.log('Manual test result:', status);
      toast.info(`Heads: ${status.debugScores.headCount}, Causes: ${status.causes.join(', ') || 'None'}`);
      
      // Manually update UI for this single test
      setCurrentStatus(status);
      setHeadCount(status.debugScores.headCount || 0);
      if (status.isAnomalous) {
        const alert = {
          time: new Date().toLocaleTimeString(),
          type: "warning",
          message: `MANUAL TEST: ${status.causes[0]}`
        };
        setAlerts(prev => [alert, ...prev].slice(0, 15));
      }
    } else {
      toast.warning("Please start monitoring before testing detection.");
    }
  }

  const exportReport = () => {
    const report = {
      sessionDuration: `${Math.floor(sessionTime / 60)}m ${sessionTime % 60}s`,
      headCount: headCount,
      headTurns: headTurns,
      gazeDeviations: gazeDeviations,
      handDetections: handDetections,
      criticalAnomalies: criticalAnomaliesCount,
      alerts: alerts
    };
    
    console.log("Exporting report:", report);
    toast.success("Report data logged to console.");
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // Determine status for the bottom-right card
  const getSafeStatus = () => {
    if (!currentStatus) return { text: "✓ Safe", issues: 0 };
    if (currentStatus.isCritical) return { text: "✗ Critical", issues: currentStatus.causes.length };
    if (currentStatus.isAnomalous) return { text: "⚠️ Alert", issues: currentStatus.causes.length };
    return { text: "✓ Safe", issues: 0 };
  }
  const safeStatus = getSafeStatus();

  return (
    <div className="min-h-screen bg-gradient-hero">
      <Navigation />
      
      <div className="container mx-auto px-4 py-8">
        <div className="mb-8 animate-fade-in">
          <h1 className="text-4xl font-bold mb-2">Video Proctoring Dashboard</h1>
          <p className="text-muted-foreground">
            Real-time exam monitoring with AI-powered behavior detection
          </p>
        </div>

        <div className="grid lg:grid-cols-3 gap-6">
          {/* Left Column - Video Feed */}
          <div className="lg:col-span-2 space-y-6">
            <Card className="shadow-medium animate-slide-up">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Video className="h-5 w-5" />
                      Live Video Feed
                    </CardTitle>
                    <CardDescription>Webcam monitoring with head pose detection</CardDescription>
                  </div>
                  {isMonitoring && (
                    <Badge variant="default" className="animate-pulse-glow">
                      <div className="h-2 w-2 rounded-full bg-destructive mr-2" />
                      LIVE
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                <div className="relative aspect-video bg-muted rounded-lg overflow-hidden">
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    className="w-full h-full object-cover"
                  />
                  {!isMonitoring && (
                    <div className="absolute inset-0 flex items-center justify-center bg-muted">
                      <Video className="h-24 w-24 text-muted-foreground/30" />
                    </div>
                  )}
                  {isMonitoring && currentStatus && (
                    <>
                      <div className="absolute top-4 left-4 space-y-2">
                        <Badge 
                          variant={currentStatus.isCritical ? "destructive" : currentStatus.isAnomalous ? "default" : "secondary"}
                          className="bg-card/80 backdrop-blur"
                        >
                          {currentStatus.statusText}
                        </Badge>
                        <Badge variant="secondary" className="bg-card/80 backdrop-blur block">
                          Heads: {headCount}
                        </Badge>
                        {currentStatus.causes.length > 0 && (
                          <Badge variant="outline" className="bg-card/80 backdrop-blur block">
                            {currentStatus.causes.join(', ')}
                          </Badge>
                        )}
                      </div>
                      <div className={`absolute inset-0 border-2 pointer-events-none rounded-lg ${
                        currentStatus.isCritical ? 'border-destructive' :
                        currentStatus.isAnomalous ? 'border-warning' :
                        'border-accent/50'
                      }`} />
                    </>
                  )}
                </div>
                
                <div className="mt-4 flex gap-2">
                  {!isMonitoring ? (
                    <Button onClick={startMonitoring} size="lg" className="flex-1" disabled={isInitializing}>
                      <Play className="mr-2 h-4 w-4" />
                      {isInitializing ? "Initializing..." : "Start Proctoring"}
                    </Button>
                  ) : (
                    <>
                      <Button onClick={stopMonitoring} variant="destructive" size="lg" className="flex-1">
                        <Square className="mr-2 h-4 w-4" />
                        Stop Session
                      </Button>
                      <Button 
                        onClick={testDetection}
                        variant="outline"
                        size="lg"
                      >
                        Test Detection
                      </Button>
                    </>
                  )}
                  <Button onClick={exportReport} variant="outline" size="lg" disabled={alerts.length === 0}>
                    <Download className="mr-2 h-4 w-4" />
                    Export Report
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Session Metrics */}
            <div className="grid md:grid-cols-7 gap-4 animate-slide-up" style={{ animationDelay: "0.1s" }}>
              <Card className="shadow-soft">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    Duration
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{formatTime(sessionTime)}</div>
                </CardContent>
              </Card>
              
              <Card className="shadow-soft">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    Heads
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{headCount}</div>
                  {headCount > 1 && (
                    <p className="text-xs text-warning mt-1">Multiple</p>
                  )}
                  {headCount === 0 && isMonitoring && (
                    <p className="text-xs text-warning mt-1">None</p>
                  )}
                </CardContent>
              </Card>
              
              <Card className="shadow-soft">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    Head Turns
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{headTurns}</div>
                  <p className="text-xs text-muted-foreground mt-1">Total</p>
                </CardContent>
              </Card>
              
              <Card className="shadow-soft">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    Gaze Shifts
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{gazeDeviations}</div>
                  <p className="text-xs text-muted-foreground mt-1">Detections</p>
                </CardContent>
              </Card>
              
              <Card className="shadow-soft">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    Hand Activity
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{handDetections}</div>
                  <p className="text-xs text-muted-foreground mt-1">Suspicious</p>
                </CardContent>
              </Card>
              
              <Card className="shadow-soft">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    Critical
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-destructive">{criticalAnomaliesCount}</div>
                  <p className="text-xs text-muted-foreground mt-1">Violations</p>
                </CardContent>
              </Card>
              
              <Card className="shadow-soft">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    Status
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-sm font-bold">
                    {safeStatus.text}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {safeStatus.issues} Issues
                  </p>
                </CardContent>
              </Card>
            </div>
          </div>

          {/* Right Column - Alerts */}
          <Card className="shadow-medium animate-slide-up" style={{ animationDelay: "0.2s" }}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5" />
                Activity Log
              </CardTitle>
              <CardDescription>Real-time monitoring alerts</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3 max-h-[600px] overflow-y-auto">
                {alerts.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <CheckCircle className="h-12 w-12 mx-auto mb-2 opacity-50" />
                    <p className="text-sm">No alerts yet</p>
                    <p className="text-xs">Start monitoring to track activity</p>
                  </div>
                ) : (
                  alerts.map((alert, index) => (
                    <div
                      key={index}
                      className="p-3 rounded-lg border bg-card animate-fade-in"
                    >
                      <div className="flex items-start gap-2">
                        {alert.type === "critical" && (
                          <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 flex-shrink-0" />
                        )}
                        {alert.type === "warning" && (
                          <AlertTriangle className="h-4 w-4 text-warning mt-0.5 flex-shrink-0" />
                        )}
                        {alert.type === "info" && (
                          <CheckCircle className="h-4 w-4 text-primary mt-0.5 flex-shrink-0" />
                        )}
                        {alert.type === "success" && (
                          <CheckCircle className="h-4 w-4 text-success mt-0.5 flex-shrink-0" />
                        )}
                        <div className="flex-1 min-w-0">
                          <p className={`text-sm font-medium ${alert.type === 'critical' ? 'text-destructive' : ''}`}>
                            {alert.message}
                          </p>
                          <p className="text-xs text-muted-foreground mt-1">{alert.time}</p>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default Proctoring;
