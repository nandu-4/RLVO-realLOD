import { FaceLandmarker, HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

// Configuration object for all thresholds
const CONFIG = {
  HEAD_DEVIATION_THRESHOLD_PX: 150, // Pixels from center
  HORIZONTAL_GAZE_THRESHOLD: 0.02, // Normalized coordinates
  VERTICAL_GAZE_THRESHOLD: 0.02, // Normalized coordinates
  HAND_PROXIMITY_Y_THRESHOLD: 0.75, // Top 75% of screen
  ANOMALY_TRIGGER_TIME_S: 10, // Seconds before critical
};

// Landmark indices
const LANDMARKS = {
  NOSE_TIP: 1,
  INDEX_FINGER_TIP: 8,
  L_IRIS_CENTER: 468,
  L_EYE_LEFT: 362,
  L_EYE_RIGHT: 263,
  L_EYE_TOP: 386,
  L_EYE_BOTTOM: 374,
  R_IRIS_CENTER: 473,
  R_EYE_LEFT: 33,
  R_EYE_RIGHT: 133,
  R_EYE_TOP: 159,
  R_EYE_BOTTOM: 145,
};

export interface ProctoringStatus {
  isAnomalous: boolean;
  isCritical: boolean;
  causes: string[];
  statusText: string;
  debugScores: Record<string, any>;
}

export class ProctoringSystem {
  private faceLandmarker: FaceLandmarker | null = null;
  private handLandmarker: HandLandmarker | null = null;
  private isInitialized = false;
  private isAnomalous = false;
  private anomalyStartTime: number | null = null;
  private videoWidth = 0;
  private videoHeight = 0;

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      const vision = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
      );

      // Initialize FaceLandmarker with multiple face detection
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

      console.log('FaceLandmarker initialized');

      // Initialize HandLandmarker
      this.handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numHands: 2,
      });

      console.log('HandLandmarker initialized');

      this.isInitialized = true;
      console.log('ProctoringSystem initialized successfully');
    } catch (error) {
      console.error('Failed to initialize ProctoringSystem:', error);
      throw error;
    }
  }

  processFrame(videoElement: HTMLVideoElement, timestamp: number): ProctoringStatus {
    if (!this.isInitialized || !this.faceLandmarker || !this.handLandmarker) {
      return {
        isAnomalous: false,
        isCritical: false,
        causes: ['System not initialized'],
        statusText: 'STATUS: Initializing...',
        debugScores: {},
      };
    }

    // Check if video is ready
    if (videoElement.readyState < 2) {
      return {
        isAnomalous: false,
        isCritical: false,
        causes: [],
        statusText: 'STATUS: Video loading...',
        debugScores: { videoReadyState: videoElement.readyState },
      };
    }

    // Update video dimensions
    this.videoWidth = videoElement.videoWidth;
    this.videoHeight = videoElement.videoHeight;

    // Validate video dimensions
    if (this.videoWidth === 0 || this.videoHeight === 0) {
      console.warn('Video dimensions are 0:', this.videoWidth, this.videoHeight);
      return {
        isAnomalous: false,
        isCritical: false,
        causes: [],
        statusText: 'STATUS: Video not ready',
        debugScores: { width: this.videoWidth, height: this.videoHeight },
      };
    }

    const causes: string[] = [];
    const debugScores: Record<string, any> = {};

    // Run both models with error handling
    let faceResults;
    let handResults;
    
    try {
      faceResults = this.faceLandmarker.detectForVideo(videoElement, timestamp);
      debugScores.facesDetected = faceResults.faceLandmarks?.length || 0;
      
      // Debug logging
      if (Math.random() < 0.1) { // Log 10% of frames to avoid console spam
        console.log('Face detection result:', {
          timestamp,
          facesDetected: faceResults.faceLandmarks?.length || 0,
          videoWidth: this.videoWidth,
          videoHeight: this.videoHeight,
          videoReadyState: videoElement.readyState,
          videoPaused: videoElement.paused,
          videoCurrentTime: videoElement.currentTime
        });
      }
    } catch (error) {
      console.error('Face detection error:', error);
      return {
        isAnomalous: false,
        isCritical: false,
        causes: ['Face detection error'],
        statusText: 'STATUS: Detection error',
        debugScores: { error: String(error) },
      };
    }

    try {
      handResults = this.handLandmarker.detectForVideo(videoElement, timestamp);
      debugScores.handsDetected = handResults.landmarks?.length || 0;
    } catch (error) {
      console.error('Hand detection error:', error);
      // Continue without hand detection
      handResults = { landmarks: [] };
    }

    // a. No Face Check
    if (!faceResults.faceLandmarks || faceResults.faceLandmarks.length === 0) {
      causes.push('No Face');
    } else {
      // b. Multiple Faces Check
      if (faceResults.faceLandmarks.length > 1) {
        causes.push('Multiple Faces');
        debugScores.faceCount = faceResults.faceLandmarks.length;
      }

      // Use the first detected face for other checks
      const landmarks = faceResults.faceLandmarks[0];

      // c. Head Deviation Check
      const noseTip = landmarks[LANDMARKS.NOSE_TIP];
      const centerX = this.videoWidth / 2;
      const nosePxX = noseTip.x * this.videoWidth;
      const headDeviation = Math.abs(nosePxX - centerX);

      debugScores.headDeviation = headDeviation.toFixed(2);

      if (headDeviation > CONFIG.HEAD_DEVIATION_THRESHOLD_PX) {
        causes.push('Head Deviation');
      }

      // d. Gaze Deviation Check (Horizontal + Vertical)
      const leftGazeDeviation = this.checkGazeDeviation(
        landmarks,
        LANDMARKS.L_IRIS_CENTER,
        LANDMARKS.L_EYE_LEFT,
        LANDMARKS.L_EYE_RIGHT,
        LANDMARKS.L_EYE_TOP,
        LANDMARKS.L_EYE_BOTTOM
      );

      const rightGazeDeviation = this.checkGazeDeviation(
        landmarks,
        LANDMARKS.R_IRIS_CENTER,
        LANDMARKS.R_EYE_LEFT,
        LANDMARKS.R_EYE_RIGHT,
        LANDMARKS.R_EYE_TOP,
        LANDMARKS.R_EYE_BOTTOM
      );

      debugScores.leftGaze = leftGazeDeviation;
      debugScores.rightGaze = rightGazeDeviation;

      if (leftGazeDeviation.isDeviating || rightGazeDeviation.isDeviating) {
        causes.push('Gaze Shift');
      }
    }

    // e. Hand Proximity Check
    if (handResults.landmarks && handResults.landmarks.length > 0) {
      for (const handLandmarks of handResults.landmarks) {
        const indexFingerTip = handLandmarks[LANDMARKS.INDEX_FINGER_TIP];
        if (indexFingerTip && indexFingerTip.y < CONFIG.HAND_PROXIMITY_Y_THRESHOLD) {
          causes.push('Hand Proximity');
          debugScores.handY = indexFingerTip.y.toFixed(3);
          break;
        }
      }
    }

    // Determine if currently anomalous
    const isCurrentlyAnomalous = causes.length > 0;

    // Critical Anomaly Timer Logic
    let isCritical = false;
    let statusText = 'STATUS: Monitoring (Safe)';

    if (isCurrentlyAnomalous) {
      if (this.anomalyStartTime === null) {
        // Start tracking anomaly
        this.anomalyStartTime = Date.now();
      } else {
        // Check duration
        const elapsedSeconds = (Date.now() - this.anomalyStartTime) / 1000;
        debugScores.anomalyDuration = elapsedSeconds.toFixed(1);

        if (elapsedSeconds >= CONFIG.ANOMALY_TRIGGER_TIME_S) {
          isCritical = true;
          statusText = 'CRITICAL: ANOMALY LOGGED!';
        } else {
          statusText = `STATUS: Anomaly Detected (${elapsedSeconds.toFixed(1)}s)`;
        }
      }
    } else {
      // Reset timer when no anomaly
      this.anomalyStartTime = null;
    }

    this.isAnomalous = isCurrentlyAnomalous;

    return {
      isAnomalous: isCurrentlyAnomalous,
      isCritical,
      causes,
      statusText,
      debugScores,
    };
  }

  private checkGazeDeviation(
    landmarks: any[],
    irisIdx: number,
    eyeLeftIdx: number,
    eyeRightIdx: number,
    eyeTopIdx: number,
    eyeBottomIdx: number
  ): { isDeviating: boolean; hDev: number; vDev: number } {
    const iris = landmarks[irisIdx];
    const eyeLeft = landmarks[eyeLeftIdx];
    const eyeRight = landmarks[eyeRightIdx];
    const eyeTop = landmarks[eyeTopIdx];
    const eyeBottom = landmarks[eyeBottomIdx];

    // Horizontal center
    const hCenter = (eyeLeft.x + eyeRight.x) / 2;
    const hDeviation = Math.abs(iris.x - hCenter);

    // Vertical center
    const vCenter = (eyeTop.y + eyeBottom.y) / 2;
    const vDeviation = Math.abs(iris.y - vCenter);

    const isHDeviating = hDeviation > CONFIG.HORIZONTAL_GAZE_THRESHOLD;
    const isVDeviating = vDeviation > CONFIG.VERTICAL_GAZE_THRESHOLD;

    return {
      isDeviating: isHDeviating || isVDeviating,
      hDev: hDeviation,
      vDev: vDeviation,
    };
  }

  dispose(): void {
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
