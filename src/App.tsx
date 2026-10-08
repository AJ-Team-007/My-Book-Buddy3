import React, { useState, useMemo, useEffect } from 'react';
import { onAuthStateChanged, User as FirebaseUser } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  where,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore';
import {
  auth,
  db,
  signInWithGoogle,
  checkGoogleRedirectResult,
  formatFirebaseAuthError,
  ParsedAuthError,
  signOutUser,
  handleFirestoreError,
  OperationType,
} from './firebase';
import {
  BookListing,
  BuyRequest,
  ChatMessage,
  Conversation,
  FilterState,
  ScreenId,
  StudentUser,
  ViewportMode,
} from './types';
import {
  DEMO_USERS,
  INITIAL_BOOKS,
  INITIAL_CONVERSATIONS,
  INITIAL_MESSAGES,
  INITIAL_REQUESTS,
} from './data/mockData';
import { AuthScreen } from './components/AuthScreen';
import { TopNav, BottomNav, SideDrawer } from './components/Navigation';
import { HomeView, BrowseView } from './components/HomeAndBrowseViews';
import { BookDetailsView, SellBookView } from './components/DetailsAndSellViews';
import { MessagesView, ChatView } from './components/MessagesAndChatViews';
import { DashboardView, BuyRequestsView } from './components/DashboardAndRequestsViews';
import {
  ProfileView,
  DemoModeView,
  TrustSafetyView,
} from './components/ProfileDemoTrustViews';
import {
  DemoTourBanner,
  ReportModal,
  RequestToBuyModal,
  SearchFiltersModal,
  ToastNotification,
  TOUR_STEPS,
} from './components/Modals';

const DEFAULT_FILTERS: FilterState = {
  search: '',
  classGrade: 'All',
  subject: 'All',
  board: 'All',
  medium: 'All',
  condition: 'All',
  availability: 'All',
  minPrice: '',
  maxPrice: '',
  sortBy: 'newest',
};

function formatTimestampLabel(ts: unknown, fallback = 'Just now'): string {
  if (ts instanceof Timestamp) {
    const date = ts.toDate();
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return fallback;
}

function buildInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase() || 'ST';
}

export default function App() {
  const [activeScreen, setActiveScreen] = useState<ScreenId>('home');
  const [viewportMode, setViewportMode] = useState<ViewportMode>('auto');
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  // Firebase Auth & Mode State
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [authReady, setAuthReady] = useState<boolean>(false);
  const [authError, setAuthError] = useState<ParsedAuthError | null>(null);
  const [isDemoMode, setIsDemoMode] = useState<boolean>(false);

  // Real Authenticated Users Map & Current User Profile (/users/{uid})
  const [realUsersMap, setRealUsersMap] = useState<Record<string, StudentUser>>({});

  // Isolated Demo Mode State (ONLY used when isDemoMode === true)
  const [demoUsersMap, setDemoUsersMap] =
    useState<Record<string, StudentUser>>(DEMO_USERS);
  const [demoCurrentUserId, setDemoCurrentUserId] = useState<string>('student-a');
  const [demoBooks, setDemoBooks] = useState<BookListing[]>(INITIAL_BOOKS);
  const [demoRequests, setDemoRequests] = useState<BuyRequest[]>(INITIAL_REQUESTS);
  const [demoConversations, setDemoConversations] =
    useState<Conversation[]>(INITIAL_CONVERSATIONS);
  const [demoMessagesByConv, setDemoMessagesByConv] =
    useState<Record<string, ChatMessage[]>>(INITIAL_MESSAGES);

  // Real Multi-User Firestore State (ONLY used in normal logged-in mode)
  const [realAvailableBooks, setRealAvailableBooks] = useState<BookListing[]>([]);
  const [realMyBooks, setRealMyBooks] = useState<BookListing[]>([]);
  const [realReceivedRequests, setRealReceivedRequests] = useState<BuyRequest[]>([]);
  const [realSentRequests, setRealSentRequests] = useState<BuyRequest[]>([]);
  const [realRawConversations, setRealRawConversations] = useState<
    Array<{
      id: string;
      listingId: string;
      bookTitle: string;
      bookPrice: number;
      bookCondition: BookListing['condition'];
      bookCover: string;
      participantIds: string[];
      buyerId: string;
      sellerId: string;
      lastMessage: string;
      lastMessageSenderId: string;
      lastTimestamp: string;
      updatedMillis: number;
    }>
  >([]);
  const [realMessagesByConv, setRealMessagesByConv] = useState<
    Record<string, ChatMessage[]>
  >({});

  // Shared UI selection state
  const [favorites, setFavorites] = useState<string[]>([]);
  const [selectedBookId, setSelectedBookId] = useState<string>('');
  const [editingBook, setEditingBook] = useState<BookListing | null>(null);
  const [activeConversationId, setActiveConversationId] = useState<string>('');

  // Filters & Modals
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [isFilterModalOpen, setIsFilterModalOpen] = useState(false);
  const [requestModalBook, setRequestModalBook] = useState<BookListing | null>(null);
  const [reportBookTitle, setReportBookTitle] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Science Fair Guided Demo Tour
  const [tourStep, setTourStep] = useState<number | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    window.setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 4000);
  };

  // Helper to fetch and cache any user's public profile from /users/{uid}
  const fetchUserProfile = async (uid: string): Promise<StudentUser | null> => {
    if (!uid || DEMO_USERS[uid]) return DEMO_USERS[uid] || null;
    if (realUsersMap[uid]) return realUsersMap[uid];
    try {
      const snap = await getDoc(doc(db, 'users', uid));
      if (snap.exists()) {
        const data = snap.data();
        const loaded: StudentUser = {
          id: uid,
          name: String(data.name || data.displayName || 'Student'),
          displayName: String(data.displayName || data.name || 'Student'),
          shortRole: 'Verified Student',
          photoURL: data.photoURL ? String(data.photoURL) : undefined,
          avatarGradient: String(
            data.avatarGradient || 'from-[#FF2E93] via-[#7B3FE4] to-[#00E5FF]'
          ),
          initials: String(data.initials || buildInitials(String(data.name || 'ST'))),
          classGrade: String(data.classGrade || data.class || 'Class 12'),
          board: String(data.board || 'CBSE'),
          school: String(data.school || 'Verified Student Community'),
          memberSince: String(data.memberSince || '2025'),
          verified: true,
          online: true,
          bio: 'Verified student on My Book Buddy sharing and requesting school textbooks.',
        };
        setRealUsersMap((prev) => ({ ...prev, [uid]: loaded }));
        return loaded;
      }
    } catch {
      // Ignore profile fetch error if user profile not created yet
    }
    return null;
  };

  // 1. Listen to Firebase Authentication State, Handle Redirect Result & Create/Update /users/{uid}
  useEffect(() => {
    let isMounted = true;
    let redirectChecked = false;
    let initialAuthFired = false;

    const markReadyIfDone = () => {
      if (isMounted && redirectChecked && initialAuthFired) {
        setAuthReady(true);
      }
    };

    checkGoogleRedirectResult()
      .then(({ credential, wasRedirectAttempt }) => {
        if (!isMounted) return;
        redirectChecked = true;
        if (credential?.user) {
          setIsDemoMode(false);
          setAuthError(null);
          showToast('Signed in with Google! Live Firebase Marketplace active.');
        } else if (wasRedirectAttempt && !auth.currentUser) {
          setAuthError(
            formatFirebaseAuthError({ code: 'auth/redirect-session-partitioned' })
          );
        }
        markReadyIfDone();
      })
      .catch((err) => {
        if (!isMounted) return;
        redirectChecked = true;
        const parsed = formatFirebaseAuthError(err);
        setAuthError(parsed);
        markReadyIfDone();
      });

    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!isMounted) return;
      setFirebaseUser(user);
      initialAuthFired = true;
      if (user) {
        // If user is already authenticated, no need to block on redirect check
        setAuthReady(true);
      } else {
        markReadyIfDone();
      }

      if (user) {
        setIsDemoMode(false);
        setAuthError(null);

        const rawName = (user.displayName || 'Verified Student').trim();
        const cleanName = rawName.slice(0, 80);
        const initials = buildInitials(cleanName);
        const photoURL = (user.photoURL || '').slice(0, 2000);
        const email = (user.email || '').slice(0, 150);
        const monthYear = new Date().toLocaleDateString('en-US', {
          month: 'short',
          year: 'numeric',
        });

        try {
          const userRef = doc(db, 'users', user.uid);
          const existingSnap = await getDoc(userRef);

          if (existingSnap.exists()) {
            const data = existingSnap.data();
            const savedName = String(data.name || data.displayName || cleanName).slice(
              0,
              100
            );
            const savedDisplayName = String(
              data.displayName || data.name || cleanName
            ).slice(0, 100);
            const savedPhoto = String(photoURL || data.photoURL || '').slice(0, 2000);
            const savedClass = String(data.class || data.classGrade || 'Class 12').slice(
              0,
              40
            );
            const savedBoard = String(data.board || 'CBSE').slice(0, 40);
            const savedSchool = String(
              data.school || 'Verified Student Community'
            ).slice(0, 120);
            const savedGradient = String(
              data.avatarGradient || 'from-[#FF2E93] via-[#7B3FE4] to-[#00E5FF]'
            ).slice(0, 100);
            const savedInitials = String(
              data.initials || buildInitials(savedName)
            ).slice(0, 6);
            const savedMemberSince = String(data.memberSince || monthYear).slice(0, 40);

            const existingProfile: StudentUser = {
              id: user.uid,
              name: savedName,
              displayName: savedDisplayName,
              shortRole: 'Verified Student',
              photoURL: savedPhoto || undefined,
              avatarGradient: savedGradient,
              initials: savedInitials,
              classGrade: savedClass,
              board: savedBoard,
              school: savedSchool,
              memberSince: savedMemberSince,
              verified: true,
              online: true,
              bio: 'Verified student on My Book Buddy.',
            };
            setRealUsersMap((prev) => ({ ...prev, [user.uid]: existingProfile }));

            await setDoc(userRef, {
              uid: user.uid,
              name: savedName,
              displayName: savedDisplayName,
              photoURL: savedPhoto,
              email,
              class: savedClass,
              classGrade: savedClass,
              board: savedBoard,
              school: savedSchool,
              avatarGradient: savedGradient,
              initials: savedInitials,
              memberSince: savedMemberSince,
              createdAt:
                data.createdAt instanceof Timestamp
                  ? data.createdAt
                  : serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          } else {
            const newProfile: StudentUser = {
              id: user.uid,
              name: cleanName,
              displayName: cleanName,
              shortRole: 'Verified Student',
              photoURL: photoURL || undefined,
              avatarGradient: 'from-[#FF2E93] via-[#7B3FE4] to-[#00E5FF]',
              initials,
              classGrade: 'Class 12',
              board: 'CBSE',
              school: 'Verified Student Community',
              memberSince: monthYear,
              verified: true,
              online: true,
              bio: 'Verified student on My Book Buddy.',
            };
            setRealUsersMap((prev) => ({ ...prev, [user.uid]: newProfile }));

            await setDoc(userRef, {
              uid: user.uid,
              name: newProfile.name.slice(0, 100),
              displayName: newProfile.displayName.slice(0, 100),
              photoURL,
              email,
              class: newProfile.classGrade.slice(0, 40),
              classGrade: newProfile.classGrade.slice(0, 40),
              board: newProfile.board.slice(0, 40),
              school: newProfile.school.slice(0, 120),
              avatarGradient: newProfile.avatarGradient.slice(0, 100),
              initials: newProfile.initials.slice(0, 6),
              memberSince: newProfile.memberSince.slice(0, 40),
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          }
        } catch (err) {
          handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}`);
        }
      }
    });
    return () => {
      isMounted = false;
      unsub();
    };
  }, []);

  // 2. Real-time Firestore Listeners for Authenticated Users (Books, BuyRequests, Conversations)
  useEffect(() => {
    if (!authReady || !firebaseUser) {
      setRealAvailableBooks([]);
      setRealMyBooks([]);
      setRealReceivedRequests([]);
      setRealSentRequests([]);
      setRealRawConversations([]);
      setRealMessagesByConv({});
      return;
    }

    const uid = firebaseUser.uid;

    const mapDocToBook = (docSnap: { id: string; data: () => Record<string, unknown> }): BookListing => {
      const data = docSnap.data();
      const createdMillis =
        data.createdAt instanceof Timestamp ? data.createdAt.toMillis() : Date.now();
      const sellerId = String(data.sellerId || '');
      if (sellerId) {
        fetchUserProfile(sellerId);
      }
      return {
        id: docSnap.id,
        title: String(data.title || ''),
        author: String(data.author || ''),
        subject: String(data.subject || 'Physics'),
        classGrade: String(data.classGrade || 'Class 11'),
        board: String(data.board || 'CBSE'),
        medium: data.medium === 'Hindi' ? 'Hindi' : 'English',
        edition: String(data.edition || '2024 Edition'),
        condition: (data.condition as BookListing['condition']) || 'Good',
        price: Number(data.price) || 200,
        originalPrice: Number(data.originalPrice) || 400,
        description: String(data.description || ''),
        coverImage: String(data.coverImage || ''),
        galleryImages: Array.isArray(data.galleryImages)
          ? (data.galleryImages as string[])
          : [String(data.coverImage || '')],
        sellerId,
        sellerName: String(data.sellerName || 'Student'),
        sellerDisplay: String(data.sellerDisplay || data.sellerName || 'Student'),
        postedTime: formatTimestampLabel(data.createdAt, 'Just now'),
        createdAt: createdMillis,
        status: data.status === 'Sold' ? 'Sold' : 'Available',
        requestsCount: Number(data.requestsCount) || 0,
      };
    };

    // 2A. All Available Books across all users
    const availBooksQuery = query(
      collection(db, 'books'),
      where('status', '==', 'Available')
    );
    const unsubAvailBooks = onSnapshot(
      availBooksQuery,
      (snapshot) => {
        const list: BookListing[] = [];
        snapshot.forEach((docSnap) => list.push(mapDocToBook(docSnap)));
        setRealAvailableBooks(list);
      },
      (error) => handleFirestoreError(error, OperationType.LIST, 'books')
    );

    // 2B. Current user's own books (both Available and Sold)
    const myBooksQuery = query(
      collection(db, 'books'),
      where('sellerId', '==', uid)
    );
    const unsubMyBooks = onSnapshot(
      myBooksQuery,
      (snapshot) => {
        const list: BookListing[] = [];
        snapshot.forEach((docSnap) => list.push(mapDocToBook(docSnap)));
        setRealMyBooks(list);
      },
      (error) => handleFirestoreError(error, OperationType.LIST, 'books')
    );

    const mapDocToRequest = (docSnap: { id: string; data: () => Record<string, unknown> }): BuyRequest => {
      const data = docSnap.data();
      const createdMillis =
        data.createdAt instanceof Timestamp ? data.createdAt.toMillis() : Date.now();
      return {
        id: docSnap.id,
        bookId: String(data.listingId || ''),
        bookTitle: String(data.bookTitle || ''),
        bookCover: String(data.bookCover || ''),
        bookPrice: Number(data.bookPrice) || 200,
        bookCondition: (data.bookCondition as BookListing['condition']) || 'Good',
        buyerId: String(data.buyerId || ''),
        buyerName: String(data.buyerName || 'Student'),
        buyerAvatarGradient: String(
          data.buyerAvatarGradient || 'from-[#00E5FF] to-[#7B3FE4]'
        ),
        buyerInitials: String(
          data.buyerInitials || buildInitials(String(data.buyerName || 'ST'))
        ),
        sellerId: String(data.sellerId || ''),
        sellerName: String(data.sellerName || 'Seller'),
        message: String(data.message || ''),
        timestamp: formatTimestampLabel(data.createdAt, 'Just now'),
        createdAt: createdMillis,
        status: (data.status as BuyRequest['status']) || 'Pending',
      };
    };

    // 2C. BuyRequests received by current user (sellerId == uid)
    const receivedReqQuery = query(
      collection(db, 'buyRequests'),
      where('sellerId', '==', uid)
    );
    const unsubReceivedReqs = onSnapshot(
      receivedReqQuery,
      (snapshot) => {
        const list: BuyRequest[] = [];
        snapshot.forEach((docSnap) => list.push(mapDocToRequest(docSnap)));
        setRealReceivedRequests(list);
      },
      (error) => handleFirestoreError(error, OperationType.LIST, 'buyRequests')
    );

    // 2D. BuyRequests sent by current user (buyerId == uid)
    const sentReqQuery = query(
      collection(db, 'buyRequests'),
      where('buyerId', '==', uid)
    );
    const unsubSentReqs = onSnapshot(
      sentReqQuery,
      (snapshot) => {
        const list: BuyRequest[] = [];
        snapshot.forEach((docSnap) => list.push(mapDocToRequest(docSnap)));
        setRealSentRequests(list);
      },
      (error) => handleFirestoreError(error, OperationType.LIST, 'buyRequests')
    );

    // 2E. Real Conversations where current user is in participantIds
    const convQuery = query(
      collection(db, 'conversations'),
      where('participantIds', 'array-contains', uid)
    );
    const unsubConvs = onSnapshot(
      convQuery,
      (snapshot) => {
        const rawList: typeof realRawConversations = [];
        snapshot.forEach((docSnap) => {
          const data = docSnap.data();
          const buyerId = String(data.buyerId || '');
          const sellerId = String(data.sellerId || '');
          const otherId = buyerId === uid ? sellerId : buyerId;
          if (otherId) {
            fetchUserProfile(otherId);
          }
          const updatedMillis =
            data.lastMessageAt instanceof Timestamp
              ? data.lastMessageAt.toMillis()
              : data.updatedAt instanceof Timestamp
              ? data.updatedAt.toMillis()
              : Date.now();
          rawList.push({
            id: docSnap.id,
            listingId: String(data.listingId || ''),
            bookTitle: String(data.bookTitle || ''),
            bookPrice: Number(data.bookPrice) || 200,
            bookCondition: (data.bookCondition as BookListing['condition']) || 'Good',
            bookCover: String(data.bookCover || ''),
            participantIds: Array.isArray(data.participantIds)
              ? (data.participantIds as string[])
              : [buyerId, sellerId],
            buyerId,
            sellerId,
            lastMessage: String(data.lastMessage || ''),
            lastMessageSenderId: String(data.lastMessageSenderId || ''),
            lastTimestamp: formatTimestampLabel(data.lastMessageAt, 'Just now'),
            updatedMillis,
          });
        });
        rawList.sort((a, b) => b.updatedMillis - a.updatedMillis);
        setRealRawConversations(rawList);
      },
      (error) => handleFirestoreError(error, OperationType.LIST, 'conversations')
    );

    return () => {
      unsubAvailBooks();
      unsubMyBooks();
      unsubReceivedReqs();
      unsubSentReqs();
      unsubConvs();
    };
  }, [authReady, firebaseUser]);

  // 3. Real-time Messages Subcollection Listener for Active Conversation
  const targetConversationId =
    activeConversationId ||
    (isDemoMode ? demoConversations[0]?.id : realRawConversations[0]?.id) ||
    '';

  useEffect(() => {
    if (!authReady || !firebaseUser || isDemoMode || !targetConversationId) return;

    const uid = firebaseUser.uid;
    const msgsPath = `conversations/${targetConversationId}/messages`;
    const msgsQuery = query(
      collection(db, 'conversations', targetConversationId, 'messages'),
      where('participantIds', 'array-contains', uid)
    );

    const unsubMsgs = onSnapshot(
      msgsQuery,
      (snapshot) => {
        const loaded: (ChatMessage & { createdMillis: number })[] = [];
        snapshot.forEach((docSnap) => {
          const data = docSnap.data();
          const createdMillis =
            data.createdAt instanceof Timestamp
              ? data.createdAt.toMillis()
              : Date.now();
          loaded.push({
            id: docSnap.id,
            conversationId: targetConversationId,
            senderId: String(data.senderId || ''),
            text: String(data.text || ''),
            timestamp: formatTimestampLabel(data.createdAt, 'Just now'),
            read: Boolean(data.read),
            attachedPhoto: data.attachedPhoto ? String(data.attachedPhoto) : undefined,
            createdMillis,
          });
        });

        loaded.sort((a, b) => a.createdMillis - b.createdMillis);

        setRealMessagesByConv((prev) => ({
          ...prev,
          [targetConversationId]: loaded,
        }));
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, msgsPath);
      }
    );

    return () => unsubMsgs();
  }, [authReady, firebaseUser, isDemoMode, targetConversationId]);

  // Compute Active User Profile
  const currentUser: StudentUser = useMemo(() => {
    if (isDemoMode) {
      return demoUsersMap[demoCurrentUserId] || DEMO_USERS['student-a'];
    }
    if (firebaseUser) {
      if (realUsersMap[firebaseUser.uid]) {
        return realUsersMap[firebaseUser.uid];
      }
      const fallbackName = firebaseUser.displayName || 'Verified Student';
      return {
        id: firebaseUser.uid,
        name: fallbackName,
        displayName: fallbackName,
        shortRole: 'Verified Student',
        photoURL: firebaseUser.photoURL || undefined,
        avatarGradient: 'from-[#FF2E93] via-[#7B3FE4] to-[#00E5FF]',
        initials: buildInitials(fallbackName),
        classGrade: 'Class 12',
        board: 'CBSE',
        school: 'Verified Student Community',
        memberSince: '2025',
        verified: true,
        online: true,
        bio: 'Verified student on My Book Buddy.',
      };
    }
    return DEMO_USERS['student-a'];
  }, [isDemoMode, demoUsersMap, demoCurrentUserId, firebaseUser, realUsersMap]);

  // Compute Active Books List (Strictly separated between Real Firebase Mode and Demo Mode)
  const books: BookListing[] = useMemo(() => {
    if (isDemoMode) {
      return demoBooks;
    }
    const map = new Map<string, BookListing>();
    realAvailableBooks.forEach((b) => map.set(b.id, b));
    realMyBooks.forEach((b) => map.set(b.id, b));
    return Array.from(map.values()).sort((a, b) => b.createdAt - a.createdAt);
  }, [isDemoMode, demoBooks, realAvailableBooks, realMyBooks]);

  // Compute Active BuyRequests List
  const requests: BuyRequest[] = useMemo(() => {
    if (isDemoMode) {
      return demoRequests;
    }
    const map = new Map<string, BuyRequest>();
    realReceivedRequests.forEach((r) => map.set(r.id, r));
    realSentRequests.forEach((r) => map.set(r.id, r));
    return Array.from(map.values()).sort((a, b) => b.createdAt - a.createdAt);
  }, [isDemoMode, demoRequests, realReceivedRequests, realSentRequests]);

  // Compute Active Conversations List with resolved partner profile
  const conversations: Conversation[] = useMemo(() => {
    if (isDemoMode) {
      return demoConversations;
    }
    if (!firebaseUser) return [];
    const uid = firebaseUser.uid;
    return realRawConversations.map((c) => {
      const otherId = c.buyerId === uid ? c.sellerId : c.buyerId;
      const otherProfile = realUsersMap[otherId];
      const otherName = otherProfile?.displayName || 'Verified Student';
      const otherClass = otherProfile
        ? `${otherProfile.classGrade} • ${otherProfile.board}`
        : 'Student Community';
      const otherGradient =
        otherProfile?.avatarGradient || 'from-[#00E5FF] to-[#7B3FE4]';
      const otherInitials = otherProfile?.initials || buildInitials(otherName);

      return {
        id: c.id,
        bookId: c.listingId,
        bookTitle: c.bookTitle,
        bookPrice: c.bookPrice,
        bookCondition: c.bookCondition,
        bookCover: c.bookCover,
        participantIds: c.participantIds,
        otherStudentId: otherId,
        otherStudentName: otherName,
        otherStudentClass: otherClass,
        otherStudentAvatarGradient: otherGradient,
        otherStudentInitials: otherInitials,
        otherStudentOnline: true,
        lastMessage: c.lastMessage,
        lastTimestamp: c.lastTimestamp,
        unreadCount: c.lastMessageSenderId && c.lastMessageSenderId !== uid ? 1 : 0,
      };
    });
  }, [isDemoMode, demoConversations, firebaseUser, realRawConversations, realUsersMap]);

  const messagesByConv = isDemoMode ? demoMessagesByConv : realMessagesByConv;

  const selectedBook = useMemo(
    () => books.find((b) => b.id === selectedBookId) || books[0] || null,
    [books, selectedBookId]
  );

  const activeConversation = useMemo(
    () =>
      conversations.find((c) => c.id === activeConversationId) ||
      conversations[0] ||
      null,
    [conversations, activeConversationId]
  );

  const filteredBooks = useMemo(() => {
    return books
      .filter((b) => {
        if (filters.search.trim()) {
          const q = filters.search.toLowerCase();
          const matchTitle = b.title.toLowerCase().includes(q);
          const matchSubject = b.subject.toLowerCase().includes(q);
          const matchAuthor = b.author.toLowerCase().includes(q);
          const matchClass = b.classGrade.toLowerCase().includes(q);
          if (!matchTitle && !matchSubject && !matchAuthor && !matchClass) return false;
        }
        if (filters.classGrade !== 'All' && b.classGrade !== filters.classGrade)
          return false;
        if (filters.subject !== 'All' && b.subject !== filters.subject) return false;
        if (filters.board !== 'All' && b.board !== filters.board) return false;
        if (filters.medium !== 'All' && b.medium !== filters.medium) return false;
        if (filters.condition !== 'All' && b.condition !== filters.condition)
          return false;
        if (filters.availability !== 'All' && b.status !== filters.availability)
          return false;
        if (filters.minPrice && b.price < Number(filters.minPrice)) return false;
        if (filters.maxPrice && b.price > Number(filters.maxPrice)) return false;
        return true;
      })
      .sort((a, b) => {
        if (filters.sortBy === 'price-asc') return a.price - b.price;
        if (filters.sortBy === 'price-desc') return b.price - a.price;
        return b.createdAt - a.createdAt;
      });
  }, [books, filters]);

  const unreadMessagesCount = useMemo(
    () => conversations.reduce((sum, c) => sum + c.unreadCount, 0),
    [conversations]
  );

  const pendingRequestsCount = useMemo(
    () =>
      requests.filter(
        (r) => r.sellerId === currentUser.id && r.status === 'Pending'
      ).length,
    [requests, currentUser.id]
  );

  // Auth Handlers (Primary = Popup Sign-In; Optional Fallback = Redirect)
  const handleGoogleSignIn = async (useRedirectFallback = false) => {
    try {
      const cred = await signInWithGoogle(useRedirectFallback);
      if (cred?.user) {
        setAuthError(null);
        setIsDemoMode(false);
        setActiveScreen('home');
        showToast('Signed in with Google! Live Firebase Marketplace active.');
      }
    } catch (err) {
      console.error('Google Sign-In error:', err);
      const parsed = formatFirebaseAuthError(err);
      setAuthError(parsed);
      showToast(parsed.message);
    }
  };

  const handleGoogleSignOut = async () => {
    try {
      await signOutUser();
      setIsDemoMode(false);
      setSelectedBookId('');
      setActiveConversationId('');
      setActiveScreen('home');
    } catch (err) {
      console.error('Sign-Out error:', err);
    }
  };

  const handleToggleFavorite = (bookId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setFavorites((prev) =>
      prev.includes(bookId) ? prev.filter((id) => id !== bookId) : [...prev, bookId]
    );
  };

  const handleSelectBook = (book: BookListing) => {
    setSelectedBookId(book.id);
    if (!isDemoMode && book.sellerId) {
      fetchUserProfile(book.sellerId);
    }
    setActiveScreen('book-details');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleNavigate = (screen: ScreenId) => {
    if (screen !== 'sell') {
      setEditingBook(null);
    }
    setActiveScreen(screen);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Helper to create or update a real 2-user conversation in Firestore without duplicates
  const getOrCreateRealConversation = async (
    book: BookListing,
    buyerId: string,
    sellerId: string,
    initialText: string,
    forceSendMessage = false
  ): Promise<string> => {
    const senderUid = firebaseUser?.uid || currentUser.id;
    const safeListingId = book.id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeBuyerId = buyerId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeSellerId = sellerId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const convId = `conv_${safeListingId}_${safeBuyerId}_${safeSellerId}`.slice(0, 120);
    const participantIds = [safeBuyerId, safeSellerId];

    const convRef = doc(db, 'conversations', convId);
    const existingSnap = await getDoc(convRef);

    const safeMessage = initialText.slice(0, 500);
    const safeTitle = (book.title || 'School Textbook').slice(0, 150);
    const safePrice = Math.max(1, Math.min(50000, Number(book.price) || 200));
    const safeCondition = book.condition || 'Good';
    const safeCover = (book.coverImage || '').slice(0, 195000);

    let shouldWriteInitialMessage = true;

    if (existingSnap.exists()) {
      if (forceSendMessage) {
        await updateDoc(convRef, {
          lastMessage: safeMessage,
          lastMessageSenderId: senderUid,
          lastMessageAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } else {
        shouldWriteInitialMessage = false;
      }
    } else {
      await setDoc(convRef, {
        conversationId: convId,
        participantIds,
        buyerId: safeBuyerId,
        sellerId: safeSellerId,
        listingId: safeListingId,
        bookTitle: safeTitle,
        bookPrice: safePrice,
        bookCondition: safeCondition,
        bookCover: safeCover,
        lastMessage: safeMessage,
        lastMessageSenderId: senderUid,
        lastMessageAt: serverTimestamp(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    // Optimistically ensure conversation is present in local state immediately
    setRealRawConversations((prev) => {
      if (prev.some((c) => c.id === convId)) {
        return forceSendMessage
          ? prev.map((c) =>
              c.id === convId
                ? {
                    ...c,
                    lastMessage: safeMessage,
                    lastMessageSenderId: senderUid,
                    lastTimestamp: 'Just now',
                    updatedMillis: Date.now(),
                  }
                : c
            )
          : prev;
      }
      return [
        {
          id: convId,
          listingId: safeListingId,
          bookTitle: safeTitle,
          bookPrice: safePrice,
          bookCondition: safeCondition,
          bookCover: safeCover,
          participantIds,
          buyerId: safeBuyerId,
          sellerId: safeSellerId,
          lastMessage: safeMessage,
          lastMessageSenderId: senderUid,
          lastTimestamp: 'Just now',
          updatedMillis: Date.now(),
        },
        ...prev,
      ];
    });

    if (shouldWriteInitialMessage) {
      const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      await setDoc(doc(db, 'conversations', convId, 'messages', msgId), {
        messageId: msgId,
        conversationId: convId,
        participantIds,
        senderId: senderUid,
        text: safeMessage,
        read: false,
        createdAt: serverTimestamp(),
      });
    }

    return convId;
  };

  // 6. Real Buy Request Submission (/buyRequests/{requestId})
  const handleSubmitBuyRequest = async (
    book: BookListing,
    buyerName: string,
    messageText: string
  ) => {
    const safeMsg = (
      messageText || 'Hi, I’m interested in this book. Is it still available?'
    ).slice(0, 250);

    if (isDemoMode) {
      const reqId = `req-${Date.now()}`;
      const newReq: BuyRequest = {
        id: reqId,
        bookId: book.id,
        bookTitle: book.title,
        bookCover: book.coverImage,
        bookPrice: book.price,
        bookCondition: book.condition,
        buyerId: currentUser.id,
        buyerName: buyerName.slice(0, 100),
        buyerAvatarGradient: currentUser.avatarGradient,
        buyerInitials: currentUser.initials,
        sellerId: book.sellerId,
        sellerName: book.sellerDisplay,
        message: safeMsg,
        timestamp: 'Just now',
        createdAt: Date.now(),
        status: 'Pending',
      };
      setDemoRequests((prev) => [newReq, ...prev]);
      setDemoBooks((prev) =>
        prev.map((b) =>
          b.id === book.id ? { ...b, requestsCount: b.requestsCount + 1 } : b
        )
      );
      setRequestModalBook(null);
      showToast('Demo Buy Request sent!');
      return;
    }

    if (!firebaseUser) return;

    if (book.sellerId === firebaseUser.uid) {
      setRequestModalBook(null);
      showToast('You cannot send a buy request for your own book listing.');
      return;
    }

    const reqId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    try {
      await setDoc(doc(db, 'buyRequests', reqId), {
        requestId: reqId,
        listingId: book.id,
        bookTitle: book.title.slice(0, 150),
        bookCover: book.coverImage.slice(0, 195000),
        bookPrice: Math.max(1, Math.min(50000, Number(book.price) || 200)),
        bookCondition: book.condition,
        buyerId: firebaseUser.uid,
        buyerName: (buyerName || currentUser.displayName).slice(0, 100),
        buyerAvatarGradient: currentUser.avatarGradient.slice(0, 100),
        buyerInitials: currentUser.initials.slice(0, 6),
        sellerId: book.sellerId,
        sellerName: book.sellerDisplay.slice(0, 100),
        message: safeMsg,
        status: 'Pending',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      // Increment requestsCount on the book listing (allowed by Tier 2 rule)
      try {
        await updateDoc(doc(db, 'books', book.id), {
          requestsCount: (Number(book.requestsCount) || 0) + 1,
          updatedAt: serverTimestamp(),
        });
      } catch {
        // Non-fatal if book was concurrently updated
      }

      // Also create/update the real 2-user conversation between Buyer and Seller
      const convId = await getOrCreateRealConversation(
        book,
        firebaseUser.uid,
        book.sellerId,
        `📘 Buy Request Sent: ${safeMsg}`,
        true
      );

      setActiveConversationId(convId);
      setRequestModalBook(null);
      showToast('Buy request sent to seller!');
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `buyRequests/${reqId}`);
    }
  };

  // 7. Real Chat Initiation ("Message Seller")
  const handleOpenChatForBook = async (book: BookListing, customBuyerId?: string) => {
    if (isDemoMode) {
      const existingConv = demoConversations.find((c) => c.bookId === book.id);
      if (existingConv) {
        setActiveConversationId(existingConv.id);
        setActiveScreen('chat');
        return;
      }
      const sellerUser = demoUsersMap[book.sellerId] || DEMO_USERS['student-b'];
      const newConvId = `conv-${Date.now()}`;
      const firstText = `Hi! I'm interested in your listing "${book.title}" (₹${book.price}).`;
      const newConv: Conversation = {
        id: newConvId,
        bookId: book.id,
        bookTitle: book.title,
        bookPrice: book.price,
        bookCondition: book.condition,
        bookCover: book.coverImage,
        participantIds: [currentUser.id, sellerUser.id],
        otherStudentId: sellerUser.id,
        otherStudentName: sellerUser.displayName,
        otherStudentClass: `${sellerUser.classGrade} • ${sellerUser.board}`,
        otherStudentAvatarGradient: sellerUser.avatarGradient,
        otherStudentInitials: sellerUser.initials,
        otherStudentOnline: true,
        lastMessage: firstText,
        lastTimestamp: 'Just now',
        unreadCount: 0,
      };
      setDemoConversations((prev) => [newConv, ...prev]);
      setDemoMessagesByConv((prev) => ({
        ...prev,
        [newConvId]: [
          {
            id: `m-${Date.now()}`,
            conversationId: newConvId,
            senderId: currentUser.id,
            text: firstText,
            timestamp: 'Just now',
            read: true,
          },
        ],
      }));
      setActiveConversationId(newConvId);
      setActiveScreen('chat');
      return;
    }

    if (!firebaseUser) return;

    const buyerId = customBuyerId || firebaseUser.uid;
    const sellerId = book.sellerId;

    if (buyerId === sellerId) {
      showToast('This is your own book listing. Check Messages for buyer chats.');
      setActiveScreen('messages');
      return;
    }

    // Check if conversation already exists in state
    const existing = conversations.find(
      (c) =>
        c.bookId === book.id &&
        c.participantIds.includes(buyerId) &&
        c.participantIds.includes(sellerId)
    );
    if (existing) {
      setActiveConversationId(existing.id);
      setActiveScreen('chat');
      return;
    }

    try {
      await fetchUserProfile(sellerId);
      await fetchUserProfile(buyerId);
      const firstText =
        buyerId === firebaseUser.uid
          ? `Hi! I'm interested in your textbook "${book.title}" (₹${book.price}). Is it still available?`
          : `Hi! I received your request for "${book.title}" (₹${book.price}). Let's coordinate the book exchange!`;
      const convId = await getOrCreateRealConversation(
        book,
        buyerId,
        sellerId,
        firstText,
        false
      );
      setActiveConversationId(convId);
      setActiveScreen('chat');
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'conversations');
    }
  };

  // Send Message in Active Conversation
  const handleSendMessage = async (
    text: string,
    attachedPhoto?: string,
    isLocationPin?: boolean
  ) => {
    if (!activeConversation) return;
    const safeText = text.slice(0, 500);
    const nowTime = new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });

    if (isDemoMode) {
      const msgId = `m-${Date.now()}`;
      const newMsg: ChatMessage = {
        id: msgId,
        conversationId: activeConversation.id,
        senderId: currentUser.id,
        text: safeText,
        timestamp: nowTime,
        read: true,
        attachedPhoto,
        isLocationPin,
      };
      setDemoMessagesByConv((prev) => ({
        ...prev,
        [activeConversation.id]: [...(prev[activeConversation.id] || []), newMsg],
      }));
      setDemoConversations((prev) =>
        prev.map((c) =>
          c.id === activeConversation.id
            ? { ...c, lastMessage: safeText, lastTimestamp: nowTime, unreadCount: 0 }
            : c
        )
      );
      return;
    }

    if (!firebaseUser) return;

    const convId = activeConversation.id;
    const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const participantIds =
      activeConversation.participantIds && activeConversation.participantIds.length === 2
        ? activeConversation.participantIds
        : [firebaseUser.uid, activeConversation.otherStudentId];

    try {
      const msgPayload: Record<string, unknown> = {
        messageId: msgId,
        conversationId: convId,
        participantIds,
        senderId: firebaseUser.uid,
        text: safeText,
        read: false,
        createdAt: serverTimestamp(),
      };
      if (attachedPhoto) {
        msgPayload.attachedPhoto = attachedPhoto.slice(0, 195000);
      }

      await setDoc(
        doc(db, 'conversations', convId, 'messages', msgId),
        msgPayload
      );

      await updateDoc(doc(db, 'conversations', convId), {
        lastMessage: safeText,
        lastMessageSenderId: firebaseUser.uid,
        lastMessageAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(
        err,
        OperationType.CREATE,
        `conversations/${convId}/messages/${msgId}`
      );
    }
  };

  // Demo-only simulated partner reply
  const handleSimulatePartnerReply = async () => {
    if (!isDemoMode || !activeConversation) return;
    const replies = [
      `Sounds great! Let's meet near the school library counter at 4:00 PM to check "${activeConversation.bookTitle}".`,
      `Yes, all chapters and diagrams are completely clean! You can inspect the book before paying ₹${activeConversation.bookPrice}.`,
      `Perfect! I will keep the textbook in my school bag tomorrow morning.`,
    ];
    const randomReply = replies[Math.floor(Math.random() * replies.length)].slice(0, 500);
    const nowTime = new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    const msgId = `m-${Date.now()}`;

    const replyMsg: ChatMessage = {
      id: msgId,
      conversationId: activeConversation.id,
      senderId: activeConversation.otherStudentId,
      text: randomReply,
      timestamp: nowTime,
      read: true,
    };

    setDemoMessagesByConv((prev) => ({
      ...prev,
      [activeConversation.id]: [...(prev[activeConversation.id] || []), replyMsg],
    }));

    setDemoConversations((prev) =>
      prev.map((c) =>
        c.id === activeConversation.id
          ? { ...c, lastMessage: randomReply, lastTimestamp: nowTime }
          : c
      )
    );
  };

  // 3 & 8. Publish / Edit Book Listing in Firestore
  const handleSaveBookListing = async (
    bookData: Omit<
      BookListing,
      | 'id'
      | 'sellerId'
      | 'sellerName'
      | 'sellerDisplay'
      | 'postedTime'
      | 'createdAt'
      | 'status'
      | 'requestsCount'
    >,
    existingId?: string
  ) => {
    if (isDemoMode) {
      const bookId = existingId || `book-${Date.now()}`;
      const newBook: BookListing = {
        ...bookData,
        id: bookId,
        sellerId: currentUser.id,
        sellerName: currentUser.name,
        sellerDisplay: currentUser.displayName,
        postedTime: 'Just now',
        createdAt: Date.now(),
        status: 'Available',
        requestsCount: 0,
      };
      if (existingId) {
        setDemoBooks((prev) =>
          prev.map((b) => (b.id === existingId ? { ...b, ...bookData } : b))
        );
      } else {
        setDemoBooks((prev) => [newBook, ...prev]);
      }
      setEditingBook(null);
      setSelectedBookId(bookId);
      setActiveScreen('book-details');
      showToast('Demo book listing saved!');
      return;
    }

    if (!firebaseUser) return;

    const uid = firebaseUser.uid;
    const bookId = existingId || `book_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    try {
      if (existingId) {
        await updateDoc(doc(db, 'books', existingId), {
          sellerName: currentUser.name.slice(0, 100),
          sellerDisplay: currentUser.displayName.slice(0, 100),
          title: bookData.title.slice(0, 150),
          author: bookData.author.slice(0, 120),
          subject: bookData.subject.slice(0, 60),
          classGrade: bookData.classGrade.slice(0, 40),
          board: bookData.board.slice(0, 40),
          medium: bookData.medium === 'Hindi' ? 'Hindi' : 'English',
          edition: bookData.edition.slice(0, 80),
          condition: bookData.condition,
          price: Math.max(1, Math.min(50000, Number(bookData.price) || 200)),
          originalPrice: Math.max(
            1,
            Math.min(50000, Number(bookData.originalPrice) || 400)
          ),
          description: bookData.description.slice(0, 1000),
          coverImage: bookData.coverImage.slice(0, 195000),
          galleryImages: (bookData.galleryImages || [bookData.coverImage])
            .slice(0, 5)
            .map((g) => g.slice(0, 195000)),
          updatedAt: serverTimestamp(),
        });
        setEditingBook(null);
        setSelectedBookId(existingId);
        setActiveScreen('book-details');
        showToast('Book listing updated in Firebase!');
      } else {
        await setDoc(doc(db, 'books', bookId), {
          sellerId: uid,
          sellerName: currentUser.name.slice(0, 100),
          sellerDisplay: currentUser.displayName.slice(0, 100),
          title: bookData.title.slice(0, 150),
          author: bookData.author.slice(0, 120),
          subject: bookData.subject.slice(0, 60),
          classGrade: bookData.classGrade.slice(0, 40),
          board: bookData.board.slice(0, 40),
          medium: bookData.medium === 'Hindi' ? 'Hindi' : 'English',
          edition: bookData.edition.slice(0, 80),
          condition: bookData.condition,
          price: Math.max(1, Math.min(50000, Number(bookData.price) || 200)),
          originalPrice: Math.max(
            1,
            Math.min(50000, Number(bookData.originalPrice) || 400)
          ),
          description: bookData.description.slice(0, 1000),
          coverImage: bookData.coverImage.slice(0, 195000),
          galleryImages: (bookData.galleryImages || [bookData.coverImage])
            .slice(0, 5)
            .map((g) => g.slice(0, 195000)),
          status: 'Available',
          requestsCount: 0,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        setSelectedBookId(bookId);
        setActiveScreen('book-details');
        showToast('Book listing published live to Firebase!');
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `books/${bookId}`);
    }
  };

  // Mark as Sold / Relist in Firestore
  const handleToggleSoldStatus = async (bookId: string) => {
    const target = books.find((b) => b.id === bookId);
    if (!target) return;
    const nextStatus = target.status === 'Available' ? 'Sold' : 'Available';

    if (isDemoMode) {
      setDemoBooks((prev) =>
        prev.map((b) => (b.id === bookId ? { ...b, status: nextStatus } : b))
      );
      showToast(`Demo book marked as ${nextStatus}!`);
      return;
    }

    if (!firebaseUser) return;
    try {
      await updateDoc(doc(db, 'books', bookId), {
        status: nextStatus,
        updatedAt: serverTimestamp(),
      });
      showToast(
        nextStatus === 'Sold'
          ? `"${target.title}" marked as Sold!`
          : `"${target.title}" relisted as Available!`
      );
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `books/${bookId}`);
    }
  };

  // Delete Book Listing in Firestore
  const handleDeleteBook = async (bookId: string) => {
    if (isDemoMode) {
      setDemoBooks((prev) => prev.filter((b) => b.id !== bookId));
      showToast('Demo listing removed.');
      return;
    }
    if (!firebaseUser) return;
    try {
      await deleteDoc(doc(db, 'books', bookId));
      showToast('Book listing deleted from Firebase.');
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `books/${bookId}`);
    }
  };

  // Accept / Decline Buy Request in Firestore
  const handleUpdateRequestStatus = async (
    requestId: string,
    newStatus: 'Accepted' | 'Declined' | 'Completed'
  ) => {
    if (isDemoMode) {
      setDemoRequests((prev) =>
        prev.map((r) => (r.id === requestId ? { ...r, status: newStatus } : r))
      );
      showToast(`Demo request marked as ${newStatus}.`);
      return;
    }

    if (!firebaseUser) return;
    try {
      await updateDoc(doc(db, 'buyRequests', requestId), {
        status: newStatus,
        updatedAt: serverTimestamp(),
      });
      showToast(`Buy request ${newStatus}!`);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `buyRequests/${requestId}`);
    }
  };

  const handleOpenChatFromRequest = async (req: BuyRequest) => {
    if (isDemoMode) {
      const book = demoBooks.find((b) => b.id === req.bookId);
      if (book) {
        handleOpenChatForBook(book);
      } else {
        setActiveScreen('messages');
      }
      return;
    }

    if (!firebaseUser) return;

    // Look for existing conversation for this listing + buyer + seller
    const existing = conversations.find(
      (c) =>
        c.bookId === req.bookId &&
        c.participantIds.includes(req.buyerId) &&
        c.participantIds.includes(req.sellerId)
    );
    if (existing) {
      setActiveConversationId(existing.id);
      setActiveScreen('chat');
      return;
    }

    const book = books.find((b) => b.id === req.bookId) || {
      id: req.bookId,
      title: req.bookTitle,
      author: 'NCERT',
      subject: 'Physics',
      classGrade: 'Class 12',
      board: 'CBSE',
      medium: 'English' as const,
      edition: '2024',
      condition: req.bookCondition,
      price: req.bookPrice,
      originalPrice: req.bookPrice + 150,
      description: req.message,
      coverImage: req.bookCover,
      galleryImages: [req.bookCover],
      sellerId: req.sellerId,
      sellerName: req.sellerName,
      sellerDisplay: req.sellerName,
      postedTime: 'Just now',
      createdAt: Date.now(),
      status: 'Available' as const,
      requestsCount: 1,
    };

    await handleOpenChatForBook(book, req.buyerId);
  };

  // Switch Demo Persona (ONLY works in Demo Mode)
  const handleSwitchDemoUser = (userId: string) => {
    if (!isDemoMode) {
      showToast('Switch to Demo Mode to test sample personas.');
      return;
    }
    if (demoUsersMap[userId]) {
      setDemoCurrentUserId(userId);
      showToast(`Switched DEMO persona to ${demoUsersMap[userId].displayName}`);
    }
  };

  const handleStartDemoTour = () => {
    setIsDemoMode(true);
    setSelectedBookId(INITIAL_BOOKS[0].id);
    setActiveConversationId(INITIAL_CONVERSATIONS[0].id);
    setTourStep(0);
    setActiveScreen(TOUR_STEPS[0].screen);
    showToast('Interactive 7-Step Science Fair Demo Tour started (DEMO DATA)!');
  };

  const handleNextTourStep = () => {
    if (tourStep === null) return;
    if (tourStep >= TOUR_STEPS.length - 1) {
      setTourStep(null);
      showToast('Demo Tour completed!');
      return;
    }
    const nextIdx = tourStep + 1;
    setTourStep(nextIdx);
    const nextScreen = TOUR_STEPS[nextIdx].screen;
    setActiveScreen(nextScreen);
    if (nextIdx === 2) {
      setRequestModalBook(selectedBook);
    } else {
      setRequestModalBook(null);
    }
  };

  const handlePrevTourStep = () => {
    if (tourStep === null || tourStep <= 0) return;
    const prevIdx = tourStep - 1;
    setTourStep(prevIdx);
    setActiveScreen(TOUR_STEPS[prevIdx].screen);
  };

  // Loading Splash while Firebase Auth Initializes
  if (!authReady) {
    return (
      <div className="min-h-screen bg-[#070A18] text-white flex flex-col items-center justify-center gap-3">
        <div className="w-12 h-12 rounded-2xl border-2 border-[#00E5FF] border-t-transparent animate-spin" />
        <p className="text-xs font-extrabold text-[#38BDF8] tracking-wider uppercase">
          Connecting to My Book Buddy Firebase Cloud...
        </p>
      </div>
    );
  }

  // 1. Start with Sign In / Create Account Screen when not authenticated and not in Demo Mode
  if (!firebaseUser && !isDemoMode) {
    return (
      <AuthScreen
        onGoogleSignIn={handleGoogleSignIn}
        onEnterDemoMode={() => {
          setIsDemoMode(true);
          setSelectedBookId(INITIAL_BOOKS[0].id);
          setActiveConversationId(INITIAL_CONVERSATIONS[0].id);
          setActiveScreen('demo');
          showToast('Entered Science Fair Demo Mode (Isolated DEMO DATA).');
        }}
        authError={authError}
      />
    );
  }

  const viewportContainerClass =
    viewportMode === 'mobile'
      ? 'max-w-[412px] mx-auto border-x border-white/15 min-h-screen shadow-[0_0_80px_rgba(123,63,228,0.3)] bg-[#070A18]'
      : viewportMode === 'tablet'
      ? 'max-w-[820px] mx-auto border-x border-white/15 min-h-screen shadow-[0_0_80px_rgba(123,63,228,0.25)] bg-[#070A18]'
      : 'w-full min-h-screen bg-[#070A18]';

  return (
    <div className="min-h-screen bg-[#050711] text-white">
      <div className={viewportContainerClass}>
        {isDemoMode && (
          <div className="bg-gradient-to-r from-[#FF2E93]/25 via-[#7B3FE4]/25 to-[#00E5FF]/25 border-b border-[#FFD13B]/40 px-4 py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="font-extrabold text-[#FFD13B]">
              🧪 SCIENCE FAIR DEMO MODE — Displaying Isolated Sample DEMO DATA
            </span>
            <button
              type="button"
              onClick={() => {
                setIsDemoMode(false);
                setTourStep(null);
                setActiveScreen('home');
              }}
              className="px-3 py-1 rounded-lg bg-[#0B0F26] hover:bg-[#121836] border border-[#00E5FF]/50 text-[#00E5FF] font-extrabold"
            >
              {firebaseUser ? 'Return to Live Firebase Mode' : 'Back to Sign In Screen'}
            </button>
          </div>
        )}

        <TopNav
          activeScreen={activeScreen}
          onNavigate={handleNavigate}
          currentUser={currentUser}
          unreadMessagesCount={unreadMessagesCount}
          pendingRequestsCount={pendingRequestsCount}
          searchQuery={filters.search}
          onSearchChange={(q) => setFilters((prev) => ({ ...prev, search: q }))}
          onSearchSubmit={() => handleNavigate('browse')}
          onOpenMenu={() => setIsMenuOpen(true)}
          viewportMode={viewportMode}
          onChangeViewportMode={setViewportMode}
          isGoogleSignedIn={Boolean(firebaseUser)}
          onGoogleSignIn={handleGoogleSignIn}
        />

        <DemoTourBanner
          tourStep={tourStep}
          onNextStep={handleNextTourStep}
          onPrevStep={handlePrevTourStep}
          onEndTour={() => setTourStep(null)}
        />

        <SideDrawer
          isOpen={isMenuOpen}
          onClose={() => setIsMenuOpen(false)}
          activeScreen={activeScreen}
          onNavigate={handleNavigate}
          currentUser={currentUser}
          viewportMode={viewportMode}
          onChangeViewportMode={setViewportMode}
          unreadMessagesCount={unreadMessagesCount}
          pendingRequestsCount={pendingRequestsCount}
        />

        <main className="max-w-7xl mx-auto px-3.5 sm:px-6 pt-5 pb-20">
          {activeScreen === 'home' && (
            <HomeView
              books={books}
              favorites={favorites}
              onToggleFavorite={handleToggleFavorite}
              onSelectBook={handleSelectBook}
              onNavigate={handleNavigate}
              searchQuery={filters.search}
              onSearchChange={(q) => setFilters((prev) => ({ ...prev, search: q }))}
              onSearchSubmit={() => handleNavigate('browse')}
              onSelectSubject={(subject) => {
                setFilters((prev) => ({ ...prev, subject }));
                handleNavigate('browse');
              }}
            />
          )}

          {activeScreen === 'browse' && (
            <BrowseView
              books={filteredBooks}
              favorites={favorites}
              onToggleFavorite={handleToggleFavorite}
              onSelectBook={handleSelectBook}
              filters={filters}
              onUpdateFilters={(partial) =>
                setFilters((prev) => ({ ...prev, ...partial }))
              }
              onResetFilters={() => setFilters(DEFAULT_FILTERS)}
              onOpenFilterModal={() => setIsFilterModalOpen(true)}
            />
          )}

          {activeScreen === 'book-details' && selectedBook && (
            <BookDetailsView
              book={selectedBook}
              sellerProfile={
                isDemoMode
                  ? demoUsersMap[selectedBook.sellerId]
                  : realUsersMap[selectedBook.sellerId] || null
              }
              isFavorite={favorites.includes(selectedBook.id)}
              onToggleFavorite={handleToggleFavorite}
              onBack={() => handleNavigate('browse')}
              onOpenRequestModal={(b) => setRequestModalBook(b)}
              onMessageSeller={(b) => handleOpenChatForBook(b)}
              onViewSellerProfile={(sellerId) => {
                if (isDemoMode) {
                  handleSwitchDemoUser(sellerId);
                  handleNavigate('profile');
                } else if (sellerId === currentUser.id) {
                  handleNavigate('profile');
                } else {
                  const s = realUsersMap[sellerId];
                  showToast(
                    `Verified Seller: ${s?.displayName || selectedBook.sellerDisplay} (${
                      s?.classGrade || selectedBook.classGrade
                    } • ${s?.board || selectedBook.board})`
                  );
                }
              }}
              onReportListing={(title) => setReportBookTitle(title)}
              onEditListing={(b) => {
                setEditingBook(b);
                setActiveScreen('sell');
              }}
              currentUser={currentUser}
            />
          )}

          {activeScreen === 'sell' && (
            <SellBookView
              editingBook={editingBook}
              onSaveBook={handleSaveBookListing}
              onCancel={() => handleNavigate('home')}
            />
          )}

          {activeScreen === 'messages' && (
            <MessagesView
              conversations={conversations}
              onSelectConversation={(conv) => {
                setActiveConversationId(conv.id);
                setActiveScreen('chat');
              }}
            />
          )}

          {activeScreen === 'chat' && activeConversation && (
            <ChatView
              conversation={activeConversation}
              messages={messagesByConv[activeConversation.id] || []}
              currentUser={currentUser}
              onBack={() => handleNavigate('messages')}
              onSendMessage={handleSendMessage}
              onSimulatePartnerReply={isDemoMode ? handleSimulatePartnerReply : undefined}
              onViewBookDetails={(bookId) => {
                setSelectedBookId(bookId);
                setActiveScreen('book-details');
              }}
              isDemoMode={isDemoMode}
            />
          )}

          {activeScreen === 'dashboard' && (
            <DashboardView
              books={books}
              requests={requests}
              currentUser={currentUser}
              onEditBook={(b) => {
                setEditingBook(b);
                setActiveScreen('sell');
              }}
              onToggleSoldStatus={handleToggleSoldStatus}
              onDeleteBook={handleDeleteBook}
              onSelectBook={handleSelectBook}
              onNavigate={handleNavigate}
              onOpenChatFromRequest={handleOpenChatFromRequest}
            />
          )}

          {activeScreen === 'requests' && (
            <BuyRequestsView
              requests={requests}
              currentUser={currentUser}
              onUpdateRequestStatus={handleUpdateRequestStatus}
              onOpenChatFromRequest={handleOpenChatFromRequest}
            />
          )}

          {activeScreen === 'profile' && (
            <ProfileView
              currentUser={currentUser}
              books={books}
              requests={requests}
              onNavigate={handleNavigate}
              onSwitchUser={handleSwitchDemoUser}
              isGoogleSignedIn={Boolean(firebaseUser)}
              onGoogleSignIn={handleGoogleSignIn}
              onGoogleSignOut={handleGoogleSignOut}
              isDemoMode={isDemoMode}
              onUpdateProfileName={async (newName, newClass, newBoard, newSchool) => {
                const initials = buildInitials(newName);
                if (isDemoMode) {
                  setDemoUsersMap((prev) => ({
                    ...prev,
                    [currentUser.id]: {
                      ...prev[currentUser.id],
                      name: newName,
                      displayName: newName,
                      initials,
                      classGrade: newClass,
                      board: newBoard,
                      school: newSchool,
                    },
                  }));
                  showToast('Demo student profile updated!');
                  return;
                }

                if (firebaseUser) {
                  const uid = firebaseUser.uid;
                  setRealUsersMap((prev) => ({
                    ...prev,
                    [uid]: {
                      ...(prev[uid] || currentUser),
                      name: newName,
                      displayName: newName,
                      initials,
                      classGrade: newClass,
                      board: newBoard,
                      school: newSchool,
                    },
                  }));

                  try {
                    await updateDoc(doc(db, 'users', uid), {
                      name: newName.slice(0, 100),
                      displayName: newName.slice(0, 100),
                      class: newClass.slice(0, 40),
                      classGrade: newClass.slice(0, 40),
                      board: newBoard.slice(0, 40),
                      school: newSchool.slice(0, 120),
                      initials: initials.slice(0, 6),
                      updatedAt: serverTimestamp(),
                    });
                    showToast('Profile saved to Firebase!');
                  } catch (err) {
                    handleFirestoreError(err, OperationType.UPDATE, `users/${uid}`);
                  }
                }
              }}
            />
          )}

          {activeScreen === 'demo' && (
            <DemoModeView
              currentUser={currentUser}
              onSwitchUser={handleSwitchDemoUser}
              onStartDemoTour={handleStartDemoTour}
              onNavigate={handleNavigate}
              isDemoMode={isDemoMode}
              onToggleDemoMode={(enable) => {
                setIsDemoMode(enable);
                if (enable) {
                  setSelectedBookId(INITIAL_BOOKS[0].id);
                  setActiveConversationId(INITIAL_CONVERSATIONS[0].id);
                  showToast('Activated isolated Science Fair DEMO DATA.');
                } else {
                  setTourStep(null);
                  showToast('Returned to Live Firebase Marketplace.');
                }
              }}
            />
          )}

          {activeScreen === 'trust' && <TrustSafetyView />}
        </main>

        <BottomNav
          activeScreen={activeScreen}
          onNavigate={handleNavigate}
          unreadMessagesCount={unreadMessagesCount}
          forceShow={viewportMode === 'mobile'}
        />

        <RequestToBuyModal
          book={requestModalBook}
          currentUser={currentUser}
          onClose={() => setRequestModalBook(null)}
          onSubmitRequest={handleSubmitBuyRequest}
        />

        <SearchFiltersModal
          isOpen={isFilterModalOpen}
          onClose={() => setIsFilterModalOpen(false)}
          filters={filters}
          onApplyFilters={(newFilters) => setFilters(newFilters)}
          onResetFilters={() => setFilters(DEFAULT_FILTERS)}
        />

        <ReportModal
          bookTitle={reportBookTitle}
          onClose={() => setReportBookTitle(null)}
          onReported={async () => {
            showToast('Thank you. Listing reported to student moderators.');
            if (firebaseUser && !isDemoMode && reportBookTitle) {
              const repId = `rep_${Date.now()}`;
              try {
                await setDoc(doc(db, 'reports', repId), {
                  bookTitle: reportBookTitle.slice(0, 150),
                  reporterUid: firebaseUser.uid,
                  reason: 'Reported via Book Details',
                  notes: 'Submitted for moderator review',
                  createdAt: serverTimestamp(),
                });
              } catch (err) {
                handleFirestoreError(err, OperationType.CREATE, `reports/${repId}`);
              }
            }
          }}
        />

        <ToastNotification
          message={toastMessage}
          onClose={() => setToastMessage(null)}
        />
      </div>
    </div>
  );
}
