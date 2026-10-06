import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  setPersistence,
  browserLocalPersistence,
  signOut as firebaseSignOut,
  UserCredential,
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
export const app =
  getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const storage = getStorage(app);

export const googleProvider = new GoogleAuthProvider();
googleProvider.addScope('profile');
googleProvider.addScope('email');
googleProvider.setCustomParameters({
  prompt: 'select_account',
});

const REDIRECT_PENDING_KEY = 'mbb_google_redirect_pending';

// Ensure persistent login across redirects and page refreshes
export const persistenceReady = setPersistence(
  auth,
  browserLocalPersistence
).catch((err) => {
  console.warn('Firebase Auth persistence setup notice:', err);
});

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

export function isMobileOrTabletBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent
  );
}

export interface ParsedAuthError {
  code: string;
  message: string;
  canUseRedirect: boolean;
  canUsePopupFallback?: boolean;
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
    rawCode.includes('auth/unauthorized-domain') ||
    rawMessage.includes('auth/unauthorized-domain')
  ) {
    return {
      code: 'auth/unauthorized-domain',
      unauthorizedDomain: currentHost,
      projectId: firebaseConfig.projectId,
      canUseRedirect: false,
      canUsePopupFallback: false,
      message: `The domain "${currentHost}" is not yet authorized in Firebase Authentication for project "${firebaseConfig.projectId}". You must add "${currentHost}" manually in: Firebase Console → Authentication → Settings → Authorized domains.`,
    };
  }

  if (
    rawCode.includes('auth/popup-blocked') ||
    rawMessage.includes('auth/popup-blocked')
  ) {
    return {
      code: 'auth/popup-blocked',
      canUseRedirect: !isEmbeddedInIframe(),
      canUsePopupFallback: false,
      message:
        'Your browser blocked the sign-in popup. Use the Redirect Sign-In button below to sign in directly in this tab without a popup.',
    };
  }

  if (
    rawCode.includes('auth/popup-closed-by-user') ||
    rawCode.includes('auth/cancelled-popup-request') ||
    rawMessage.includes('auth/popup-closed-by-user')
  ) {
    return {
      code: 'auth/popup-closed-by-user',
      canUseRedirect: !isEmbeddedInIframe(),
      canUsePopupFallback: true,
      message:
        'The Google Sign-In window was closed before completing login. Use "Continue with Google (Redirect)" to sign in without a popup.',
    };
  }

  if (
    rawCode.includes('auth/account-exists-with-different-credential') ||
    rawMessage.includes('auth/account-exists-with-different-credential')
  ) {
    return {
      code: 'auth/account-exists-with-different-credential',
      canUseRedirect: false,
      canUsePopupFallback: false,
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
      canUseRedirect: !isEmbeddedInIframe(),
      canUsePopupFallback: true,
      message:
        'Network request failed while connecting to Google Authentication. Please check your internet connection or ad-blocker and try again.',
    };
  }

  return {
    code: rawCode || 'auth/error',
    canUseRedirect: !isEmbeddedInIframe(),
    canUsePopupFallback: true,
    message: rawMessage || 'Unable to complete Google Sign-In. Please try again.',
  };
}

/**
 * Checks and resolves any pending Google Sign-In redirect result on page load.
 */
export async function checkGoogleRedirectResult(): Promise<{
  credential: UserCredential | null;
  wasRedirectAttempt: boolean;
}> {
  const wasRedirectAttempt =
    typeof sessionStorage !== 'undefined' &&
    sessionStorage.getItem(REDIRECT_PENDING_KEY) === '1';

  try {
    await persistenceReady;
    const result = await getRedirectResult(auth);
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(REDIRECT_PENDING_KEY);
    }
    return { credential: result, wasRedirectAttempt };
  } catch (err) {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(REDIRECT_PENDING_KEY);
    }
    console.error('Firebase getRedirectResult error:', err);
    throw err;
  }
}

/**
 * Primary Google Sign-In method:
 * Uses Firebase's redirect-based authentication (signInWithRedirect) on standalone web & mobile browsers.
 * Falls back to popup only if running inside an embedded iframe where top-level redirects are blocked by Google X-Frame-Options.
 */
export async function signInWithGoogleRedirect(): Promise<UserCredential | null> {
  await persistenceReady;
  if (!isEmbeddedInIframe()) {
    try {
      sessionStorage.setItem(REDIRECT_PENDING_KEY, '1');
    } catch {
      // Ignore storage error
    }
    await signInWithRedirect(auth, googleProvider);
    return null;
  }
  return signInWithPopup(auth, googleProvider);
}

/**
 * Optional Popup Fallback Google Sign-In:
 * Attempts signInWithPopup and automatically switches to signInWithRedirect if the browser blocks popups.
 */
export async function signInWithGooglePopupFallback(): Promise<UserCredential | null> {
  await persistenceReady;
  const inIframe = isEmbeddedInIframe();

  if (!inIframe && isMobileOrTabletBrowser()) {
    return signInWithGoogleRedirect();
  }

  try {
    return await signInWithPopup(auth, googleProvider);
  } catch (err) {
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code?: unknown }).code || '')
        : '';

    if (
      !inIframe &&
      (code === 'auth/popup-blocked' ||
        code === 'auth/operation-not-supported-in-this-environment' ||
        code === 'auth/cancelled-popup-request')
    ) {
      return signInWithGoogleRedirect();
    }

    throw err;
  }
}

/**
 * Unified Google Sign-In entry point:
 * - Default (usePopupFallback = false): uses signInWithRedirect on deployed Vercel / standalone web & mobile browsers.
 * - Optional (usePopupFallback = true): uses signInWithPopup with automatic redirect fallback if blocked.
 */
export async function signInWithGoogle(
  usePopupFallback = false
): Promise<UserCredential | null> {
  if (usePopupFallback) {
    return signInWithGooglePopupFallback();
  }
  return signInWithGoogleRedirect();
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
