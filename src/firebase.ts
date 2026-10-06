import { initializeApp } from 'firebase/app';
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

const firebaseConfig = {
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

const app = initializeApp(firebaseConfig);

export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const storage = getStorage(app);

export const googleProvider = new GoogleAuthProvider();
googleProvider.addScope('profile');
googleProvider.addScope('email');
googleProvider.setCustomParameters({
  prompt: 'select_account',
});

// Ensure persistent login across redirects and page refreshes
setPersistence(auth, browserLocalPersistence).catch((err) => {
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
  unauthorizedDomain?: string;
}

export function formatFirebaseAuthError(error: unknown): ParsedAuthError {
  const rawCode =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code || '')
      : '';
  const rawMessage = error instanceof Error ? error.message : String(error);
  const currentHost =
    typeof window !== 'undefined' ? window.location.hostname : 'your Vercel domain';

  if (
    rawCode.includes('auth/unauthorized-domain') ||
    rawMessage.includes('auth/unauthorized-domain')
  ) {
    return {
      code: 'auth/unauthorized-domain',
      unauthorizedDomain: currentHost,
      canUseRedirect: false,
      message: `Domain "${currentHost}" is not yet authorized in Firebase Authentication. Add "${currentHost}" in Firebase Console → Authentication → Settings → Authorized domains (Project ID: ${firebaseConfig.projectId}).`,
    };
  }

  if (
    rawCode.includes('auth/popup-blocked') ||
    rawMessage.includes('auth/popup-blocked')
  ) {
    return {
      code: 'auth/popup-blocked',
      canUseRedirect: !isEmbeddedInIframe(),
      message:
        'Your browser blocked the sign-in popup. Click "Continue with Google Redirect (No Popup)" below to sign in directly in this tab.',
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
      message:
        'The Google Sign-In window was closed before completing login. You can click "Continue with Google Redirect (No Popup)" below to sign in without a popup.',
    };
  }

  if (
    rawCode.includes('auth/account-exists-with-different-credential') ||
    rawMessage.includes('auth/account-exists-with-different-credential')
  ) {
    return {
      code: 'auth/account-exists-with-different-credential',
      canUseRedirect: false,
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
      canUseRedirect: true,
      message:
        'Network request failed while connecting to Google Authentication. Please check your internet connection or firewall/ad-blocker and try again.',
    };
  }

  return {
    code: rawCode || 'auth/unknown',
    canUseRedirect: !isEmbeddedInIframe(),
    message: rawMessage || 'Unable to complete Google Sign-In. Please try again.',
  };
}

/**
 * Checks and resolves any pending Google Sign-In redirect result on page load.
 */
export async function checkGoogleRedirectResult(): Promise<UserCredential | null> {
  try {
    const result = await getRedirectResult(auth);
    return result;
  } catch (err) {
    console.error('Firebase getRedirectResult error:', err);
    throw err;
  }
}

/**
 * Explicitly initiates redirect-based Google Sign-In (no popup required).
 * Falls back to popup only if running inside a cross-origin preview iframe where top-level redirect is blocked by Google X-Frame-Options.
 */
export async function signInWithGoogleRedirect(): Promise<UserCredential | null> {
  if (!isEmbeddedInIframe()) {
    await signInWithRedirect(auth, googleProvider);
    return null;
  }
  return signInWithPopup(auth, googleProvider);
}

/**
 * Primary Google Sign-In flow:
 * - Uses redirect authentication automatically on mobile/tablet browsers or when preferRedirect is true (if not inside an iframe).
 * - Otherwise attempts signInWithPopup and automatically switches to signInWithRedirect if the browser blocks popups.
 */
export async function signInWithGoogle(
  preferRedirect = false
): Promise<UserCredential | null> {
  const inIframe = isEmbeddedInIframe();
  const useRedirectFirst =
    !inIframe && (preferRedirect || isMobileOrTabletBrowser());

  if (useRedirectFirst) {
    await signInWithRedirect(auth, googleProvider);
    return null;
  }

  try {
    return await signInWithPopup(auth, googleProvider);
  } catch (err) {
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code?: unknown }).code || '')
        : '';

    // Automatically fall back to redirect when popup is blocked or unsupported
    if (
      !inIframe &&
      (code === 'auth/popup-blocked' ||
        code === 'auth/operation-not-supported-in-this-environment' ||
        code === 'auth/cancelled-popup-request')
    ) {
      await signInWithRedirect(auth, googleProvider);
      return null;
    }

    throw err;
  }
}

export async function signOutUser() {
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
