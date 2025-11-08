import { FaceLandmarker, HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

export interface ProctoringStatus {
  isAnomalous: boolean;
  isCritical: boolean;
  causes: string[];
  statusText: string;
  debugScores: {
    headCount?: number;
    headDeviationPx?: number;
    leftGazeH?: number;
    leftGazeV?: number;
    rightGazeH?: number;
    rightGazeV?: number;
    handY?: number;
  };
}

interface ProctoringConfig {
  HEAD_DEVIATION_THRESHOLD_PX: number;
  HORIZONTAL_GAZE_THRESHOLD: number;
  VERTICAL_GAZE_THRESHOLD: number;
  HAND_PROXIMITY_Y_THRESHOLD: number;
  ANOMALY_TRIGGER_TIME_S: number;
}

export class ProctoringSystem {
  private faceLandmarker: FaceLandmarker | null = null;
  private handLandmarker: HandLandmarker | null = null;
  private isInitialized = false;
  private anomalyStartTime: number | null = null;
  private lastCriticalLogTime: number = 0;
  
  private readonly CONFIG: ProctoringConfig = {
    HEAD_DEVIATION_THRESHOLD_PX: 150,
    HORIZONTAL_GAZE_THRESHOLD: 0.04,
    VERTICAL_GAZE_THRESHOLD: 0.04,
    HAND_PROXIMITY_Y_THRESHOLD: 0.75,
    ANOMALY_TRIGGER_TIME_S: 10,
  };

  // Landmark indices
  private readonly NOSE_TIP = 1;
  private readonly INDEX_FINGER_TIP = 8;
  private readonly L_IRIS_CENTER = 468;
  private readonly L_EYE_LEFT = 362;
  private readonly L_EYE_RIGHT = 263;
  private readonly L_EYE_TOP = 386;
  private readonly L_EYE_BOTTOM = 374;
  private readonly R_IRIS_CENTER = 473;
  private readonly R_EYE_LEFT = 33;
  private readonly R_EYE_RIGHT = 133;
  private readonly R_EYE_TOP = 159;
  private readonly R_EYE_BOTTOM = 145;

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      console.log('Initializing MediaPipe models...');
      const vision = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
      );

      this.faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numFaces: 2,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: false,
      });

      this.handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numHands: 2,
      });

      this.isInitialized = true;
      console.log('MediaPipe models initialized successfully');
    } catch (error) {
      console.error('Failed to initialize MediaPipe:', error);
      throw error;
    }
  }

  processFrame(videoElement: HTMLVideoElement, timestamp: number): ProctoringStatus {
    if (!this.isInitialized || !this.faceLandmarker || !this.handLandmarker) {
      return {
        isAnomalous: false,
        isCritical: false,
        causes: ['System initializing...'],
        statusText: 'STATUS: Initializing',
        debugScores: {},
      };
    }

    // Validate video element
    if (videoElement.readyState < 2 || videoElement.videoWidth === 0) {
      return {
        isAnomalous: false,
        isCritical: false,
        causes: ['Video not ready'],
        statusText: 'STATUS: Waiting for video',
        debugScores: {},
      };
    }

    const causes: string[] = [];
    const debugScores: ProctoringStatus['debugScores'] = {};

    try {
      // Run face detection
      const faceResults = this.faceLandmarker.detectForVideo(videoElement, timestamp);
      const faceCount = faceResults.faceLandmarks?.length || 0;
      debugScores.headCount = faceCount;

      // Check 1: No Face
      if (faceCount === 0) {
        causes.push('No Face');
      }
      // Check 2: Multiple Faces
      else if (faceCount > 1) {
        causes.push('Multiple Faces');
      }
      // Check 3 & 4: Head Deviation and Gaze (only if exactly 1 face)
      else if (faceCount === 1) {
        const landmarks = faceResults.faceLandmarks[0];
        const videoWidth = videoElement.videoWidth;
        const videoHeight = videoElement.videoHeight;

        // Check 3: Head Deviation
        const noseTip = landmarks[this.NOSE_TIP];
        const noseTipX = noseTip.x * videoWidth;
        const centerX = videoWidth / 2;
        const headDeviation = Math.abs(noseTipX - centerX);
        debugScores.headDeviationPx = headDeviation;

        if (headDeviation > this.CONFIG.HEAD_DEVIATION_THRESHOLD_PX) {
          causes.push('Head Deviation');
        }

        // Check 4: Gaze Deviation (Horizontal + Vertical)
        // Left Eye
        const lIrisCenter = landmarks[this.L_IRIS_CENTER];
        const lEyeLeft = landmarks[this.L_EYE_LEFT];
        const lEyeRight = landmarks[this.L_EYE_RIGHT];
        const lEyeTop = landmarks[this.L_EYE_TOP];
        const lEyeBottom = landmarks[this.L_EYE_BOTTOM];

        const lHCenter = (lEyeLeft.x + lEyeRight.x) / 2;
        const lVCenter = (lEyeTop.y + lEyeBottom.y) / 2;
        const lHDeviation = Math.abs(lIrisCenter.x - lHCenter);
        const lVDeviation = Math.abs(lIrisCenter.y - lVCenter);
        
        debugScores.leftGazeH = lHDeviation;
        debugScores.leftGazeV = lVDeviation;

        // Right Eye
        const rIrisCenter = landmarks[this.R_IRIS_CENTER];
        const rEyeLeft = landmarks[this.R_EYE_LEFT];
        const rEyeRight = landmarks[this.R_EYE_RIGHT];
        const rEyeTop = landmarks[this.R_EYE_TOP];
        const rEyeBottom = landmarks[this.R_EYE_BOTTOM];

        const rHCenter = (rEyeLeft.x + rEyeRight.x) / 2;
        const rVCenter = (rEyeTop.y + rEyeBottom.y) / 2;
        const rHDeviation = Math.abs(rIrisCenter.x - rHCenter);
        const rVDeviation = Math.abs(rIrisCenter.y - rVCenter);

        debugScores.rightGazeH = rHDeviation;
        debugScores.rightGazeV = rVDeviation;

        const isHDeviating = lHDeviation > this.CONFIG.HORIZONTAL_GAZE_THRESHOLD || 
                            rHDeviation > this.CONFIG.HORIZONTAL_GAZE_THRESHOLD;
        const isVDeviating = lVDeviation > this.CONFIG.VERTICAL_GAZE_THRESHOLD || 
                            rVDeviation > this.CONFIG.VERTICAL_GAZE_THRESHOLD;

        if (isHDeviating || isVDeviating) {
          causes.push('Gaze Shift');
        }
      }

      // Check 5: Hand Proximity
      const handResults = this.handLandmarker.detectForVideo(videoElement, timestamp);
      if (handResults.landmarks && handResults.landmarks.length > 0) {
        for (const handLandmarks of handResults.landmarks) {
          const indexFingerTip = handLandmarks[this.INDEX_FINGER_TIP];
          debugScores.handY = indexFingerTip.y;

          if (indexFingerTip.y < this.CONFIG.HAND_PROXIMITY_Y_THRESHOLD) {
            causes.push('Hand Proximity');
            break;
          }
        }
      }

    } catch (error) {
      console.error('Error processing frame:', error);
      causes.push('Processing Error');
    }

    // Determine anomaly state
    const isAnomalous = causes.length > 0;
    let isCritical = false;

    // Track anomaly duration
    if (isAnomalous) {
      if (this.anomalyStartTime === null) {
        this.anomalyStartTime = Date.now();
      } else {
        const duration = (Date.now() - this.anomalyStartTime) / 1000;
        if (duration >= this.CONFIG.ANOMALY_TRIGGER_TIME_S) {
          isCritical = true;
        }
      }
    } else {
      this.anomalyStartTime = null;
    }

    // Generate status text
    let statusText = 'STATUS: Monitoring (Safe)';
    if (isCritical) {
      statusText = 'CRITICAL: ANOMALY LOGGED!';
    } else if (isAnomalous) {
      const duration = this.anomalyStartTime ? (Date.now() - this.anomalyStartTime) / 1000 : 0;
      statusText = `WARNING: ${causes[0]} (${duration.toFixed(1)}s)`;
    }

    return {
      isAnomalous,
      isCritical,
      causes,
      statusText,
      debugScores,
    };
  }

  getAnomalyDuration(): number {
    if (this.anomalyStartTime === null) return 0;
    return (Date.now() - this.anomalyStartTime) / 1000;
  }

  resetCriticalTimer(): void {
    this.lastCriticalLogTime = Date.now();
  }

  shouldLogCritical(): boolean {
    // Prevent duplicate logs within 5 seconds
    return Date.now() - this.lastCriticalLogTime > 5000;
  }

  destroy(): void {
    if (this.faceLandmarker) {
      this.faceLandmarker.close();
      this.faceLandmarker = null;
    }
    if (this.handLandmarker) {
      this.handLandmarker.close();
      this.handLandmarker = null;
    }
    this.isInitialized = false;
  }
}
