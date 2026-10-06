import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  initializeAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  indexedDBLocalPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  browserPopupRedirectResolver,
  signOut as firebaseSignOut,
  UserCredential,
  Auth,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDocFromServer,
} from 'firebase/firestore';
import {
  getStorage,
  ref,
  uploadString,
  getDownloadURL,
} from 'firebase/storage';
import defaultFirebaseConfig from '../firebase-applet-config.json';

export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || defaultFirebaseConfig.apiKey,
  authDomain:
    import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || defaultFirebaseConfig.authDomain,
  projectId:
    import.meta.env.VITE_FIREBASE_PROJECT_ID || defaultFirebaseConfig.projectId,
  storageBucket:
    import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ||
    defaultFirebaseConfig.storageBucket,
  messagingSenderId:
    import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ||
    defaultFirebaseConfig.messagingSenderId,
  appId: import.meta.env.VITE_FIREBASE_APP_ID || defaultFirebaseConfig.appId,
  firestoreDatabaseId:
    import.meta.env.VITE_FIREBASE_DATABASE_ID ||
    defaultFirebaseConfig.firestoreDatabaseId,
};

// Initialize Firebase only once (singleton guard)
const isAlreadyInitialized = getApps().length > 0;
export const app = isAlreadyInitialized
  ? getApp()
  : initializeApp(firebaseConfig);

// Initialize Auth synchronously with local persistence & popupRedirectResolver
// so signInWithPopup executes synchronously inside the user's click gesture without any pre-await delay.
function createOrGetAuth(): Auth {
  if (isAlreadyInitialized) {
    return getAuth(app);
  }
  try {
    return initializeAuth(app, {
      persistence: [
        indexedDBLocalPersistence,
        browserLocalPersistence,
        browserSessionPersistence,
      ],
      popupRedirectResolver: browserPopupRedirectResolver,
    });
  } catch {
    return getAuth(app);
  }
}

export const auth = createOrGetAuth();
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const storage = getStorage(app);

export const googleProvider = new GoogleAuthProvider();
googleProvider.addScope('profile');
googleProvider.addScope('email');
googleProvider.setCustomParameters({
  prompt: 'select_account',
});

const REDIRECT_PENDING_KEY = 'mbb_google_redirect_pending';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Validate connection to Firestore on boot
async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('the client is offline')
    ) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
testConnection();

export function isEmbeddedInIframe(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

export interface ParsedAuthError {
  code: string;
  message: string;
  canRetryPopup: boolean;
  canUseRedirectFallback: boolean;
  unauthorizedDomain?: string;
  projectId?: string;
}

export function formatFirebaseAuthError(error: unknown): ParsedAuthError {
  const rawCode =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code || '')
      : '';
  const rawMessage = error instanceof Error ? error.message : String(error);
  const currentHost =
    typeof window !== 'undefined' && window.location.hostname
      ? window.location.hostname
      : 'my-book-buddy3-wpxk.vercel.app';

  if (
    rawCode.includes('auth/redirect-session-partitioned') ||
    rawMessage.includes('auth/redirect-session-partitioned')
  ) {
    return {
      code: 'auth/redirect-session-partitioned',
      canRetryPopup: true,
      canUseRedirectFallback: false,
      message:
        'Your browser restricted cross-domain redirect cookies. Please click "Continue with Google" below to sign in using the direct Google Sign-In popup window (which does not require third-party redirect cookies).',
    };
  }

  if (
    rawCode.includes('auth/unauthorized-domain') ||
    rawMessage.includes('auth/unauthorized-domain')
  ) {
    return {
      code: 'auth/unauthorized-domain',
      unauthorizedDomain: currentHost,
      projectId: firebaseConfig.projectId,
      canRetryPopup: true,
      canUseRedirectFallback: false,
      message: `The domain "${currentHost}" is not yet authorized in Firebase Authentication for project "${firebaseConfig.projectId}". Add "${currentHost}" in Firebase Console → Authentication → Settings → Authorized domains.`,
    };
  }

  if (
    rawCode.includes('auth/popup-blocked') ||
    rawMessage.includes('auth/popup-blocked')
  ) {
    return {
      code: 'auth/popup-blocked',
      canRetryPopup: true,
      canUseRedirectFallback: !isEmbeddedInIframe(),
      message:
        'Your browser blocked the Google Sign-In popup window. Please allow popups for this site and click "Continue with Google" again, or try the Redirect fallback option below.',
    };
  }

  if (
    rawCode.includes('auth/popup-closed-by-user') ||
    rawMessage.includes('auth/popup-closed-by-user')
  ) {
    return {
      code: 'auth/popup-closed-by-user',
      canRetryPopup: true,
      canUseRedirectFallback: !isEmbeddedInIframe(),
      message:
        'The Google Sign-In window was closed before completing login. Click "Continue with Google" to sign in again.',
    };
  }

  if (
    rawCode.includes('auth/cancelled-popup-request') ||
    rawMessage.includes('auth/cancelled-popup-request')
  ) {
    return {
      code: 'auth/cancelled-popup-request',
      canRetryPopup: true,
      canUseRedirectFallback: false,
      message:
        'Another sign-in popup was already open. Click "Continue with Google" to complete your sign-in.',
    };
  }

  if (
    rawCode.includes('auth/account-exists-with-different-credential') ||
    rawMessage.includes('auth/account-exists-with-different-credential')
  ) {
    return {
      code: 'auth/account-exists-with-different-credential',
      canRetryPopup: true,
      canUseRedirectFallback: false,
      message:
        'An account already exists with the same email address under a different sign-in credential. Please sign in with your original account method.',
    };
  }

  if (
    rawCode.includes('auth/network-request-failed') ||
    rawMessage.includes('auth/network-request-failed')
  ) {
    return {
      code: 'auth/network-request-failed',
      canRetryPopup: true,
      canUseRedirectFallback: false,
      message:
        'Network request failed while connecting to Google Authentication. Please check your internet connection or ad-blocker and try again.',
    };
  }

  return {
    code: rawCode || 'auth/error',
    canRetryPopup: true,
    canUseRedirectFallback: !isEmbeddedInIframe(),
    message: rawMessage || 'Unable to complete Google Sign-In. Please try again.',
  };
}

/**
 * Checks and resolves any pending Google Sign-In redirect result on page load.
 * Never starts an automatic redirect loop.
 */
export async function checkGoogleRedirectResult(): Promise<{
  credential: UserCredential | null;
  wasRedirectAttempt: boolean;
}> {
  let wasRedirectAttempt = false;
  try {
    if (typeof sessionStorage !== 'undefined') {
      wasRedirectAttempt = sessionStorage.getItem(REDIRECT_PENDING_KEY) === '1';
      sessionStorage.removeItem(REDIRECT_PENDING_KEY);
    }
  } catch {
    // Ignore storage access errors
  }

  try {
    const result = await getRedirectResult(auth, browserPopupRedirectResolver);
    return { credential: result, wasRedirectAttempt };
  } catch (err) {
    console.error('Firebase getRedirectResult error:', err);
    throw err;
  }
}

/**
 * PRIMARY Google Sign-In method:
 * Uses signInWithPopup synchronously inside the click handler so the user activation
 * gesture is never lost and cross-domain third-party redirect cookies are not needed.
 */
export function signInWithGooglePopup(): Promise<UserCredential> {
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(REDIRECT_PENDING_KEY);
    }
  } catch {
    // Ignore storage error
  }
  return signInWithPopup(auth, googleProvider, browserPopupRedirectResolver);
}

/**
 * OPTIONAL Redirect Fallback:
 * Only used when explicitly requested by the user if their environment cannot open popups.
 */
export async function signInWithGoogleRedirectFallback(): Promise<UserCredential | null> {
  if (isEmbeddedInIframe()) {
    return signInWithGooglePopup();
  }
  try {
    sessionStorage.setItem(REDIRECT_PENDING_KEY, '1');
  } catch {
    // Ignore storage error
  }
  await signInWithRedirect(auth, googleProvider, browserPopupRedirectResolver);
  return null;
}

/**
 * Unified Google Sign-In entry point:
 * - Default (useRedirectFallback = false): uses Popup Sign-In as PRIMARY method (works on Vercel desktop & mobile without cross-domain redirect cookies).
 * - Fallback (useRedirectFallback = true): uses Redirect Sign-In when explicitly requested.
 */
export async function signInWithGoogle(
  useRedirectFallback = false
): Promise<UserCredential | null> {
  if (useRedirectFallback) {
    return signInWithGoogleRedirectFallback();
  }
  return signInWithGooglePopup();
}

export async function signOutUser() {
  try {
    sessionStorage.removeItem(REDIRECT_PENDING_KEY);
  } catch {
    // Ignore storage error
  }
  return firebaseSignOut(auth);
}

/**
 * Compresses an uploaded image file to a lightweight Data URL (< 120KB)
 * and attempts to upload to Firebase Storage if available, returning a public URL or safe Data URL.
 */
export async function processAndUploadBookImage(file: File): Promise<string> {
  const dataUrl = await compressImageToDataUrl(file, 720, 0.72);
  try {
    if (auth.currentUser) {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const storageRef = ref(
        storage,
        `book_images/${auth.currentUser.uid}/${Date.now()}_${safeName}`
      );
      await uploadString(storageRef, dataUrl, 'data_url');
      const downloadUrl = await getDownloadURL(storageRef);
      if (downloadUrl && downloadUrl.length <= 200000) {
        return downloadUrl;
      }
    }
  } catch {
    // Fallback to compressed Data URL if Storage bucket rules/provisioning are restricted
  }
  return dataUrl.slice(0, 195000);
}

function compressImageToDataUrl(
  file: File,
  maxWidth = 720,
  quality = 0.72
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read image file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => resolve(String(reader.result || '').slice(0, 195000));
      img.onload = () => {
        const scale = Math.min(1, maxWidth / (img.width || maxWidth));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(String(reader.result || '').slice(0, 195000));
          return;
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const compressed = canvas.toDataURL('image/jpeg', quality);
        resolve(compressed.slice(0, 195000));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}
