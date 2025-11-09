import { FaceLandmarker, HandLandmarker, FilesetResolver, FaceLandmarkerResult, HandLandmarkerResult } from '@mediapipe/tasks-vision';

/**
 * The main status object returned every frame.
 */
export interface ProctoringStatus {
  isAnomalous: boolean;
  isCritical: boolean;
  causes: string[];
  statusText: string;
  debugScores: {
    headCount?: number;
    headDeviationH?: number; // %
    headDeviationV?: number; // %
    leftGazeH?: number;      // %
    leftGazeV?: number;      // %
    rightGazeH?: number;     // %
    rightGazeV?: number;     // %
    handY?: number;          // %
  };
}

interface ProctoringConfig {
  HEAD_DEVIATION_H_THRESHOLD: number; // Horizontal deviation in % (0-1)
  HEAD_DEVIATION_V_THRESHOLD: number; // Vertical deviation in % (0-1)
  HORIZONTAL_GAZE_THRESHOLD: number;  // Horizontal gaze in % (0-1)
  VERTICAL_GAZE_THRESHOLD: number;    // Vertical gaze in % (0-1)
  HAND_PROXIMITY_Y_THRESHOLD: number; // Hand proximity in % (0.0 = top, 1.0 = bottom)
  ANOMALY_TRIGGER_TIME_S: number;     // Seconds an anomaly must persist
  HAND_CONFIDENCE: number;            // Minimum confidence for hand detection
}

export class ProctoringSystem {
  private faceLandmarker: FaceLandmarker | null = null;
  private handLandmarker: HandLandmarker | null = null;
  private isInitialized = false;
  
  // State for anomaly timing
  private anomalyStartTime: number | null = null;
  private currentAnomalyCause: string = '';

  // --- CONFIGURATION ---
  private readonly CONFIG: ProctoringConfig = {
    HEAD_DEVIATION_H_THRESHOLD: 0.15, // 15% from center
    HEAD_DEVIATION_V_THRESHOLD: 0.1,  // 10% from center
    HORIZONTAL_GAZE_THRESHOLD: 0.4,   // 40% (looking far left/right)
    VERTICAL_GAZE_THRESHOLD: 0.4,     // 40% (looking far up/down)
    HAND_PROXIMITY_Y_THRESHOLD: 0.9,  // 90% (anything in the top 90% of the screen)
    ANOMALY_TRIGGER_TIME_S: 5,        // 5 seconds to trigger critical
    HAND_CONFIDENCE: 0.3,             // 30% confidence for hand detection
  };

  // --- LANDMARK INDICES ---
  private readonly NOSE_TIP = 1;
  private readonly INDEX_FINGER_TIP = 8;
  // Left Eye
  private readonly L_IRIS_CENTER = 468;
  private readonly L_EYE_LEFT = 362;
  private readonly L_EYE_RIGHT = 263;
  private readonly L_EYE_TOP = 386;
  private readonly L_EYE_BOTTOM = 374;
  // Right Eye
  private readonly R_IRIS_CENTER = 473;
  private readonly R_EYE_LEFT = 33;
  private readonly R_EYE_RIGHT = 133;
  private readonly R_EYE_TOP = 159;
  private readonly R_EYE_BOTTOM = 145;

  /**
   * Initializes the MediaPipe models.
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      console.log('Initializing MediaPipe models...');
      const vision = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.12/wasm'
      );

      this.faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numFaces: 2, // Allow detecting multiple faces
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: false,
        // @ts-ignore - refineLandmarks is critical for iris tracking but not in all TS defs
        refineLandmarks: true, // MUST be true for iris tracking
      });

      this.handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: this.CONFIG.HAND_CONFIDENCE,
        minTrackingConfidence: 0.5,
      });

      await Promise.all([
        this.faceLandmarker.setOptions({ runningMode: 'VIDEO' }),
        this.handLandmarker.setOptions({ runningMode: 'VIDEO' })
      ]);

      this.isInitialized = true;
      console.log('MediaPipe models initialized successfully');
    } catch (error) {
      console.error('Failed to initialize MediaPipe:', error);
      throw error;
    }
  }
  
  /**
   * Resets all internal counters and timers. Called by the UI on "Start".
   */
  public reset(): void {
    this.anomalyStartTime = null;
    this.currentAnomalyCause = '';
  }

  /**
   * Returns the duration of the current anomaly. Called by the UI for logging.
   */
  public getAnomalyDuration(): number {
    if (this.anomalyStartTime === null) return 0;
    return (Date.now() - this.anomalyStartTime) / 1000;
  }

  /**
   * Processes a single video frame and returns the proctoring status.
   */
  processFrame(videoElement: HTMLVideoElement, timestamp: number): ProctoringStatus {
    if (!this.isInitialized || !this.faceLandmarker || !this.handLandmarker || videoElement.readyState < 2) {
      return this.createStatusObject([], false, 0, {});
    }

    let causes: string[] = [];
    let debugScores: ProctoringStatus['debugScores'] = {};

    try {
      // --- Run Detections ---
      const faceResults = this.faceLandmarker.detectForVideo(videoElement, timestamp);
      const handResults = this.handLandmarker.detectForVideo(videoElement, timestamp);

      // --- Process Detections ---
      const faceCount = faceResults.faceLandmarks?.length || 0;
      debugScores.headCount = faceCount;

      // Check 1: No Face
      if (faceCount === 0) {
        causes.push('No Face Detected');
      }
      // Check 2: Multiple Faces
      else if (faceCount > 1) {
        causes.push('Multiple Faces');
      }
      // Check 3 & 4: Head/Gaze (only if 1 face)
      else if (faceCount === 1) {
        const landmarks = faceResults.faceLandmarks[0];
        
        // Check 3: Head Deviation
        const { isHDeviating, isVDeviating, hDev, vDev } = this._checkHead(landmarks);
        debugScores.headDeviationH = hDev;
        debugScores.headDeviationV = vDev;
        if (isHDeviating) causes.push('Head Deviation (H)');
        if (isVDeviating) causes.push('Head Deviation (V)');
        
        // Check 4: Gaze Deviation
        const { isGazeDeviating, lGazeH, lGazeV, rGazeH, rGazeV } = this._checkGaze(landmarks);
        debugScores.leftGazeH = lGazeH;
        debugScores.leftGazeV = lGazeV;
        debugScores.rightGazeH = rGazeH;
        debugScores.rightGazeV = rGazeV;
        if (isGazeDeviating) causes.push('Gaze Shift');
      }

      // Check 5: Hand Proximity
      const { isHandProximity, handY } = this._checkHands(handResults);
      debugScores.handY = handY;
      if (isHandProximity) causes.push('Hand Proximity');

    } catch (error) {
      // console.error('Error in MediaPipe detection:', error);
      // Fails silently to avoid console spam, e.g. on timestamp issues
    }

    // --- Update Anomaly State ---
    const isAnomalous = causes.length > 0;
    let isCritical = false;
    let anomalyDuration = 0;
    const primaryCause = causes[0] || '';

    if (isAnomalous) {
      if (this.anomalyStartTime === null) {
        this.anomalyStartTime = Date.now();
      }
      
      if (this.currentAnomalyCause !== primaryCause) {
        this.currentAnomalyCause = primaryCause;
        this.anomalyStartTime = Date.now();
      }
      
      anomalyDuration = (Date.now() - this.anomalyStartTime) / 1000;
      
      if (anomalyDuration >= this.CONFIG.ANOMALY_TRIGGER_TIME_S) {
        isCritical = true;
      }
    } else {
      this.anomalyStartTime = null;
      this.currentAnomalyCause = '';
    }
    
    // --- Return Status ---
    return this.createStatusObject(causes, isCritical, anomalyDuration, debugScores);
  }

  /**
   * Helper to create the status object.
   */
  private createStatusObject(
    causes: string[], 
    isCritical: boolean, 
    duration: number, 
    debugScores: ProctoringStatus['debugScores']
  ): ProctoringStatus {
    let statusText = 'STATUS: Monitoring (Safe)';
    if (isCritical) {
      statusText = `CRITICAL: ${causes[0]}`;
    } else if (causes.length > 0) {
      statusText = `WARNING: ${causes[0]} (${duration.toFixed(1)}s)`;
    }

    return {
      isAnomalous: causes.length > 0,
      isCritical,
      causes,
      statusText,
      debugScores,
    };
  }

  /**
   * Checks for horizontal and vertical head deviation.
   */
  private _checkHead(landmarks: any[]) {
    const noseTip = landmarks[this.NOSE_TIP];
    const noseX = noseTip.x;
    const noseY = noseTip.y;

    const hDev = Math.abs(noseX - 0.5); // 0.5 is center
    const vDev = Math.abs(noseY - 0.5); // 0.5 is center
    
    const isHDeviating = hDev > this.CONFIG.HEAD_DEVIATION_H_THRESHOLD;
    const isVDeviating = vDev > this.CONFIG.HEAD_DEVIATION_V_THRESHOLD;

    return { isHDeviating, isVDeviating, hDev: hDev * 100, vDev: vDev * 100 };
  }

  /**
   * Checks for horizontal and vertical gaze deviation.
   */
  private _checkGaze(landmarks: any[]) {
    try {
      // Left Eye
      const lIris = landmarks[this.L_IRIS_CENTER];
      const lEyeL = landmarks[this.L_EYE_LEFT];
      const lEyeR = landmarks[this.L_EYE_RIGHT];
      const lEyeT = landmarks[this.L_EYE_TOP];
      const lEyeB = landmarks[this.L_EYE_BOTTOM];

      const lEyeWidth = Math.abs(lEyeL.x - lEyeR.x);
      const lEyeHeight = Math.abs(lEyeT.y - lEyeB.y);
      const lEyeCenterX = (lEyeL.x + lEyeR.x) / 2;
      const lEyeCenterY = (lEyeT.y + lEyeB.y) / 2;
      
      if (lEyeWidth === 0 || lEyeHeight === 0) throw new Error("Left eye width/height is zero");

      const lGazeH = Math.abs(lIris.x - lEyeCenterX) / lEyeWidth;
      const lGazeV = Math.abs(lIris.y - lEyeCenterY) / lEyeHeight;

      // Right Eye
      const rIris = landmarks[this.R_IRIS_CENTER];
      const rEyeL = landmarks[this.R_EYE_LEFT];
      const rEyeR = landmarks[this.R_EYE_RIGHT];
      const rEyeT = landmarks[this.R_EYE_TOP];
      const rEyeB = landmarks[this.R_EYE_BOTTOM];

      const rEyeWidth = Math.abs(rEyeL.x - rEyeR.x);
      const rEyeHeight = Math.abs(rEyeT.y - rEyeB.y);
      const rEyeCenterX = (rEyeL.x + rEyeR.x) / 2;
      const rEyeCenterY = (rEyeT.y + rEyeB.y) / 2;

      if (rEyeWidth === 0 || rEyeHeight === 0) throw new Error("Right eye width/height is zero");

      const rGazeH = Math.abs(rIris.x - rEyeCenterX) / rEyeWidth;
      const rGazeV = Math.abs(rIris.y - rEyeCenterY) / rEyeHeight;

      const isHDeviating = lGazeH > this.CONFIG.HORIZONTAL_GAZE_THRESHOLD || rGazeH > this.CONFIG.HORIZONTAL_GAZE_THRESHOLD;
      const isVDeviating = lGazeV > this.CONFIG.VERTICAL_GAZE_THRESHOLD || rGazeV > this.CONFIG.VERTICAL_GAZE_THRESHOLD;

      return { isGazeDeviating: isHDeviating || isVDeviating, lGazeH: lGazeH * 100, lGazeV: lGazeV * 100, rGazeH: rGazeH * 100, rGazeV: rGazeV * 100 };
    } catch (e) {
      // This will catch errors from missing landmarks (e.g., if refineLandmarks was false)
      // console.warn("Error in _checkGaze:", e.message);
      return { isGazeDeviating: false, lGazeH: 0, lGazeV: 0, rGazeH: 0, rGazeV: 0 };
    }
  }

  /**
   * Checks for hand proximity.
   */
  private _checkHands(handResults: HandLandmarkerResult) {
    let isHandProximity = false;
    let handY = 0; // 0.0 = top, 1.0 = bottom

    if (handResults.landmarks && handResults.landmarks.length > 0) {
      for (const handLandmarks of handResults.landmarks) {
        if (handLandmarks && handLandmarks.length > this.INDEX_FINGER_TIP) {
          const indexFingerTip = handLandmarks[this.INDEX_FINGER_TIP];
          handY = indexFingerTip.y; 
          
          if (handY < this.CONFIG.HAND_PROXIMITY_Y_THRESHOLD) {
            isHandProximity = true;
            break; 
          }
        }
      }
    }
    return { isHandProximity, handY: handY * 100 };
  }

  /**
   * Cleans up the MediaPipe models.
   */
  public destroy(): void {
    this.faceLandmarker?.close();
    this.handLandmarker?.close();
    this.isInitialized = false;
    console.log("Proctoring system destroyed and models closed.");
  }
}
