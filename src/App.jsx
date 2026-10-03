import { Fragment, useEffect, useRef, useState } from 'react'
import { createUserWithEmailAndPassword, deleteUser, EmailAuthProvider, onAuthStateChanged, reauthenticateWithCredential, signInWithEmailAndPassword, signOut, updatePassword } from 'firebase/auth'
import { collection, deleteDoc, doc, getDoc, getDocFromCache, onSnapshot, query, runTransaction, serverTimestamp, setDoc, updateDoc, where } from 'firebase/firestore'
import { useLocation, useNavigate } from 'react-router-dom'
import { auth, db, firebaseConfigured } from './firebase'
import './App.css'

const pages = [
  { id: 'requests', label: 'My Requests', icon: '▤' },
  { id: 'voucher', label: 'Request Voucher', icon: '🎓' },
  { id: 'approvals', label: 'Approve Request', icon: '✓' },
]

const locations = ['Bengaluru', 'Nagpur', 'Gurgaon', 'Hyderabad', 'Kolkata', 'Indore', 'Noida', 'Mohali', 'Chandigarh', 'Mysore', 'Bhubaneswar', 'Trivandrum', 'Pune', 'Mcity']
const certifications = Array.from({ length: 9 }, (_, index) => `PL-${(index + 1) * 100}`)

function isApprover(userProfile) {
  return ['manager', 'approver'].includes(String(userProfile?.role ?? '').toLowerCase())
}

function getFirebaseErrorMessage(error) {
  const messages = {
    'auth/email-already-in-use': 'An account already exists for this email.',
    'auth/invalid-credential': 'Email or password is incorrect.',
    'auth/invalid-email': 'Enter a valid email address.',
    'auth/operation-not-allowed': 'Enable Email/Password sign-in in Firebase Authentication.',
    'auth/requires-recent-login': 'Sign in again before changing your password.',
    'auth/weak-password': 'Choose a stronger password.',
    'auth/wrong-password': 'The current password is incorrect.',
    'permission-denied': 'Firebase denied this request. Check your account access and the data required by the Firestore rules.',
  }

  return messages[error.code] ?? 'Could not complete the request. Check your Firebase setup and try again.'
}

function formatRequestDate(timestamp) {
  const date = timestamp?.toDate?.()
  return date
    ? new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).format(date)
    : '-'
}

async function createLocalProfilePhoto(file) {
  if (!file.type.startsWith('image/')) {
    throw new Error('Choose an image file for your profile photo.')
  }
  if (file.size > 10 * 1024 * 1024) {
    throw new Error('Choose an image smaller than 10 MB.')
  }

  const image = await createImageBitmap(file)
  const maxDimension = 512
  const scale = Math.min(1, maxDimension / Math.max(image.width, image.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.width * scale))
  canvas.height = Math.max(1, Math.round(image.height * scale))
  const context = canvas.getContext('2d')
  if (!context) {
    image.close()
    throw new Error('Could not process the selected profile photo.')
  }

  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  image.close()
  return canvas.toDataURL('image/jpeg', 0.82)
}

function createVoucherCode() {
  const digitLengthRandom = new Uint8Array(1)
  globalThis.crypto.getRandomValues(digitLengthRandom)
  const digitLength = 3 + (digitLengthRandom[0] % 3)
  const minimum = 10 ** (digitLength - 1)
  const range = 9 * minimum
  const limit = Math.floor(0x100000000 / range) * range
  const randomValue = new Uint32Array(1)
  let value

  do {
    globalThis.crypto.getRandomValues(randomValue)
    value = randomValue[0]
  } while (value >= limit)

  return `MSVC${minimum + (value % range)}`
}

function getPageFromPathname(pathname) {
  const normalizedPath = pathname.replace(/\/+$/, '') || '/'
  const routes = {
    '/': 'login',
    '/requests': 'requests',
    '/voucher': 'voucher',
    '/approvals': 'approvals',
    '/signup': 'signup',
  }

  if (routes[normalizedPath]) return routes[normalizedPath]
  if (/^\/[^/]+\/profile$/.test(normalizedPath)) return 'profile'
  return 'login'
}

function getProfilePath(userProfile, user) {
  const usernameSource = userProfile?.username ?? userProfile?.name ?? user?.email?.split('@')[0] ?? user?.uid ?? 'user'
  const username = String(usernameSource)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'user'

  return `/${encodeURIComponent(username)}/profile`
}

function App() {
  const navigate = useNavigate()
  const location = useLocation()
  const navigateRef = useRef(navigate)
  const pathnameRef = useRef(location.pathname)
  const activePage = getPageFromPathname(location.pathname)
  const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false)
  const [authUser, setAuthUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [profileSection, setProfileSection] = useState('details')
  const [isEditingProfile, setIsEditingProfile] = useState(false)
  const [isSavingProfile, setIsSavingProfile] = useState(false)
  const [isChangingPassword, setIsChangingPassword] = useState(false)
  const [profilePhoto, setProfilePhoto] = useState('')
  const [isProfilePhotoPreviewOpen, setIsProfilePhotoPreviewOpen] = useState(false)
  const [voucherRequests, setVoucherRequests] = useState([])
  const [requestsLoading, setRequestsLoading] = useState(false)
  const [approvalRequests, setApprovalRequests] = useState([])
  const [approvalsLoading, setApprovalsLoading] = useState(false)
  const [cancelingRequestId, setCancelingRequestId] = useState(null)
  const [reviewingRequestId, setReviewingRequestId] = useState(null)
  const [rejectionDraftRequestId, setRejectionDraftRequestId] = useState(null)
  const [rejectionRemarks, setRejectionRemarks] = useState('')
  const [expandedRequestId, setExpandedRequestId] = useState(null)
  const [copiedVoucherCode, setCopiedVoucherCode] = useState(null)
  const [formMessage, setFormMessage] = useState(null)
  const [dismissingMessage, setDismissingMessage] = useState(null)
  const profileAreaRef = useRef(null)
  const profilePhotoInputRef = useRef(null)
  const profilePhotoPreviewRef = useRef(null)
  const loginEmailRef = useRef(null)
  const pageHistoryRef = useRef([])
  const [loginAttention, setLoginAttention] = useState(false)
  const [loginAttentionCycle, setLoginAttentionCycle] = useState(0)

  useEffect(() => {
    const dialog = profilePhotoPreviewRef.current
    if (!dialog) return

    if (isProfilePhotoPreviewOpen && !dialog.open) {
      dialog.showModal()
    } else if (!isProfilePhotoPreviewOpen && dialog.open) {
      dialog.close()
    }
  }, [isProfilePhotoPreviewOpen])

  useEffect(() => {
    navigateRef.current = navigate
    pathnameRef.current = location.pathname
  }, [location.pathname, navigate])

  useEffect(() => {
    if (!formMessage) return undefined

    const messageToDismiss = formMessage
    const dismissTimeoutId = window.setTimeout(() => setDismissingMessage(messageToDismiss), 2300)
    const removeTimeoutId = window.setTimeout(() => setFormMessage(null), 3000)
    return () => {
      window.clearTimeout(dismissTimeoutId)
      window.clearTimeout(removeTimeoutId)
    }
  }, [formMessage])

  useEffect(() => {
    if (!firebaseConfigured) return undefined
    return onAuthStateChanged(auth, (user) => {
      pageHistoryRef.current = []
      setAuthUser(user)
      if (user) {
        try {
          setProfilePhoto(window.localStorage.getItem(`msvportal.profilePhoto.${user.uid}`) ?? '')
        } catch {
          setProfilePhoto('')
          setFormMessage({ type: 'error', text: 'Could not read the locally saved profile photo in this browser.' })
        }
        setProfile(null)
        setProfileLoading(true)
      } else {
        setProfilePhoto('')
        const currentPage = getPageFromPathname(pathnameRef.current)
        if (!['login', 'signup'].includes(currentPage)) {
          navigateRef.current('/', { replace: true })
        }
        setProfile(null)
        setProfileLoading(false)
      }
    })
  }, [])

  useEffect(() => {
    if (!authUser) return undefined

    let isCurrent = true
    let hasServerResponse = false
    const userProfileRef = doc(db, 'users', authUser.uid)

    getDocFromCache(userProfileRef)
      .then((snapshot) => {
        if (!isCurrent || hasServerResponse) return
        if (snapshot.exists()) {
          setProfile(snapshot.data())
          setProfileLoading(false)
        }
      })
      .catch((error) => {
        if (isCurrent && !['unavailable', 'firestore/cache-miss'].includes(error.code)) {
          setFormMessage({ type: 'error', text: getFirebaseErrorMessage(error) })
        }
      })

    getDoc(userProfileRef)
      .then((snapshot) => {
        if (!isCurrent) return
        hasServerResponse = true
        setProfile(snapshot.exists() ? snapshot.data() : null)
      })
      .catch((error) => {
        if (isCurrent) {
          hasServerResponse = true
          setFormMessage({ type: 'error', text: getFirebaseErrorMessage(error) })
        }
      })
      .finally(() => {
        if (isCurrent) setProfileLoading(false)
      })

    return () => {
      isCurrent = false
    }
  }, [authUser])

  function setActivePage(pageId, options = {}) {
    const pagePaths = {
      login: '/',
      requests: '/requests',
      voucher: '/voucher',
      approvals: '/approvals',
      signup: '/signup',
      profile: getProfilePath(profile, authUser),
    }
    const destination = pagePaths[pageId]
    if (!destination) return

    if (pageId !== activePage && options.track !== false) pageHistoryRef.current.push(activePage)
    navigate(destination, { replace: options.replace ?? false })
  }

  useEffect(() => {
    if (!authUser || profileLoading || isApprover(profile) || activePage !== 'requests') return undefined

    return onSnapshot(
      query(collection(db, 'voucherRequests'), where('userId', '==', authUser.uid)),
      (snapshot) => {
        const requests = snapshot.docs
          .map((requestSnapshot) => ({ id: requestSnapshot.id, ...requestSnapshot.data() }))
          .sort((first, second) => (second.createdAt?.toMillis?.() ?? 0) - (first.createdAt?.toMillis?.() ?? 0))
        setVoucherRequests(requests)
        setRequestsLoading(false)
      },
      (error) => {
        setFormMessage({ type: 'error', text: getFirebaseErrorMessage(error) })
        setRequestsLoading(false)
      },
    )
  }, [activePage, authUser, profile, profileLoading])

  useEffect(() => {
    if (!authUser || activePage !== 'approvals' || !isApprover(profile)) return undefined

    return onSnapshot(
      query(collection(db, 'voucherRequests'), where('status', '==', 'pending')),
      (snapshot) => {
        const requests = snapshot.docs
          .map((requestSnapshot) => ({ id: requestSnapshot.id, ...requestSnapshot.data() }))
          .filter((request) => request.userId !== authUser.uid)
          .sort((first, second) => (second.createdAt?.toMillis?.() ?? 0) - (first.createdAt?.toMillis?.() ?? 0))
        setApprovalRequests(requests)
        setApprovalsLoading(false)
      },
      (error) => {
        setFormMessage({ type: 'error', text: getFirebaseErrorMessage(error) })
        setApprovalsLoading(false)
      },
    )
  }, [activePage, authUser, profile])

  useEffect(() => {
    if (!isProfileMenuOpen) return undefined

    function closeOnOutsideClick(event) {
      if (!profileAreaRef.current?.contains(event.target)) {
        setIsProfileMenuOpen(false)
      }
    }

    function closeOnEscape(event) {
      if (event.key === 'Escape') setIsProfileMenuOpen(false)
    }

    document.addEventListener('pointerdown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [isProfileMenuOpen])

  useEffect(() => {
    if (loginAttention && activePage === 'login') loginEmailRef.current?.focus()
  }, [activePage, loginAttention])

  async function handleLogin(event) {
    event.preventDefault()
    setFormMessage(null)
    if (!firebaseConfigured) {
      setFormMessage({ type: 'error', text: 'Firebase is not configured. Follow the setup steps in README.md.' })
      return
    }

    const formData = new FormData(event.currentTarget)
    try {
      await signInWithEmailAndPassword(
        auth,
        String(formData.get('email') ?? '').trim(),
        String(formData.get('password') ?? ''),
      )
    } catch (error) {
      setFormMessage({ type: 'error', text: getFirebaseErrorMessage(error) })
    }
  }

  async function handleVoucherSubmit(event) {
    event.preventDefault()
    setFormMessage(null)
    if (!firebaseConfigured) {
      setFormMessage({ type: 'error', text: 'Firebase is not configured. Follow the setup steps in README.md.' })
      return
    }
    if (isApprover(profile)) {
      setFormMessage({ type: 'error', text: 'Managers cannot submit voucher requests.' })
      return
    }
    if (!authUser || !profile) {
      setFormMessage({ type: 'error', text: 'Sign in with your account before submitting a voucher request.' })
      return
    }

    const formData = new FormData(event.currentTarget)
    try {
      const counterRef = doc(db, 'referenceCounters', 'voucherRequests')
      let referenceNumber

      await runTransaction(db, async (transaction) => {
        const counterSnapshot = await transaction.get(counterRef)
        const lastReference = counterSnapshot.exists() ? counterSnapshot.data().lastReference : 3071
        if (!Number.isInteger(lastReference) || lastReference < 1000) {
          throw new Error('The voucher request reference counter is invalid.')
        }

        referenceNumber = Math.max(lastReference, 3071) + 1
        const requestRef = doc(db, 'voucherRequests', String(referenceNumber))

        transaction.set(counterRef, { lastReference: referenceNumber, lastRequestId: requestRef.id })
        transaction.set(requestRef, {
          userId: authUser.uid,
          employeeId: profile.employeeId,
          employeeName: profile.name,
          employeeEmail: authUser.email,
          employeeLocation: String(formData.get('employeeLocation') ?? ''),
          certificationCode: String(formData.get('certificationCode') ?? ''),
          remarks: String(formData.get('remarks') ?? ''),
          referenceNumber,
          status: 'pending',
          createdAt: serverTimestamp(),
        })
      })

      setActivePage('requests')
      setRequestsLoading(true)
      setFormMessage({ type: 'success', text: `Voucher request ${referenceNumber} saved.` })
    } catch (error) {
      setFormMessage({ type: 'error', text: getFirebaseErrorMessage(error) })
    }
  }

  async function handleCancelRequest(request) {
    if (!authUser || isApprover(profile) || request.status !== 'pending') return
    const reference = request.referenceNumber ?? 'this'
    if (!window.confirm(`Cancel and delete voucher request ${reference}?`)) return

    setCancelingRequestId(request.id)
    setFormMessage(null)
    try {
      await deleteDoc(doc(db, 'voucherRequests', request.id))
      setVoucherRequests((currentRequests) => currentRequests.filter((current) => current.id !== request.id))
      setFormMessage({ type: 'success', text: `Voucher request ${reference} was deleted.` })
    } catch (error) {
      setFormMessage({ type: 'error', text: getFirebaseErrorMessage(error) })
    } finally {
      setCancelingRequestId(null)
    }
  }

  async function handleReviewRequest(request, status, remarks = '') {
    if (!isApprover(profile) || request.status !== 'pending') return
    const normalizedRemarks = remarks.trim()
    if (status === 'rejected' && !normalizedRemarks) return

    setReviewingRequestId(request.id)
    setFormMessage(null)
    try {
      let voucherCode = null
      const requestRef = doc(db, 'voucherRequests', request.id)

      if (status === 'approved') {
        for (let attempt = 0; attempt < 10 && !voucherCode; attempt += 1) {
          const candidate = createVoucherCode()
          const codeRef = doc(db, 'voucherCodes', candidate)

          try {
            await runTransaction(db, async (transaction) => {
              const [requestSnapshot, codeSnapshot] = await Promise.all([
                transaction.get(requestRef),
                transaction.get(codeRef),
              ])
              if (!requestSnapshot.exists() || requestSnapshot.data().status !== 'pending') {
                throw new Error('This request is no longer pending review.')
              }
              if (codeSnapshot.exists()) {
                const collisionError = new Error('Generated voucher code already exists.')
                collisionError.code = 'voucher-code-exists'
                throw collisionError
              }

              transaction.update(requestRef, {
                status: 'approved',
                reviewedAt: serverTimestamp(),
                reviewedBy: authUser.email,
                voucherCode: candidate,
              })
              transaction.set(codeRef, {
                requestId: request.id,
                createdAt: serverTimestamp(),
              })
            })
            voucherCode = candidate
          } catch (error) {
            if (error.code !== 'voucher-code-exists') throw error
          }
        }

        if (!voucherCode) throw new Error('Could not allocate a unique voucher code. Try approving again.')
      } else {
        await updateDoc(requestRef, {
          status,
          reviewedAt: serverTimestamp(),
          reviewedBy: authUser.email,
          rejectionRemarks: normalizedRemarks,
        })
      }

      setApprovalRequests((currentRequests) => currentRequests.filter((current) => current.id !== request.id))
      setRejectionDraftRequestId(null)
      setRejectionRemarks('')
      setFormMessage({
        type: 'success',
        text: status === 'approved'
          ? `Request ${request.referenceNumber ?? ''} approved.`
          : `Request ${request.referenceNumber ?? ''} rejected.`,
      })
    } catch (error) {
      setFormMessage({ type: 'error', text: getFirebaseErrorMessage(error) })
    } finally {
      setReviewingRequestId(null)
    }
  }

  async function handleCopyVoucherCode(voucherCode) {
    try {
      await navigator.clipboard.writeText(voucherCode)
      setCopiedVoucherCode(voucherCode)
    } catch {
      setFormMessage({ type: 'error', text: 'Could not copy the voucher code. Select and copy it manually.' })
    }
  }

  async function handleSignUp(event) {
    event.preventDefault()
    setFormMessage(null)
    if (!firebaseConfigured) {
      setFormMessage({ type: 'error', text: 'Firebase is not configured. Follow the setup steps in README.md.' })
      return
    }

    const formData = new FormData(event.currentTarget)
    const name = String(formData.get('name') ?? '').trim()
    const email = String(formData.get('email') ?? '').trim().toLowerCase()
    const password = String(formData.get('password') ?? '')
    const employeeId = String(formData.get('employeeId') ?? '')
    const location = String(formData.get('location') ?? '')

    let createdUser
    try {
      const credential = await createUserWithEmailAndPassword(auth, email, password)
      createdUser = credential.user
      try {
        await setDoc(doc(db, 'users', createdUser.uid), {
          name,
          email,
          employeeId,
          location,
          createdAt: serverTimestamp(),
        })
      } catch (error) {
        await deleteUser(createdUser).catch(() => {})
        throw error
      }

      await signOut(auth)
      setActivePage('login')
      setFormMessage({ type: 'success', text: 'Account created. Sign in with your email and password.' })
    } catch (error) {
      setFormMessage({ type: 'error', text: getFirebaseErrorMessage(error) })
    }
  }

  function handleEmployeeIdInput(event) {
    event.currentTarget.value = event.currentTarget.value.replace(/\D/g, '').slice(0, 7)
  }

  async function handleProfileSave(event) {
    event.preventDefault()
    if (!authUser || !profile) {
      setFormMessage({ type: 'error', text: 'Profile details are not available to save yet.' })
      return
    }

    const formData = new FormData(event.currentTarget)
    const name = String(formData.get('name') ?? '').trim()
    const employeeId = String(formData.get('employeeId') ?? '').trim()
    const profileLocation = String(formData.get('location') ?? '')
    if (!name || !/^\d{7}$/.test(employeeId) || !locations.includes(profileLocation)) {
      setFormMessage({ type: 'error', text: 'Enter a name, a 7-digit employee ID, and a valid location.' })
      return
    }

    setIsSavingProfile(true)
    setFormMessage(null)
    try {
      const updatedProfile = { name, employeeId, location: profileLocation }
      await updateDoc(doc(db, 'users', authUser.uid), updatedProfile)
      setProfile((currentProfile) => ({ ...currentProfile, ...updatedProfile }))
      setIsEditingProfile(false)
      setFormMessage({ type: 'success', text: 'Profile details saved.' })
    } catch (error) {
      setFormMessage({ type: 'error', text: getFirebaseErrorMessage(error) })
    } finally {
      setIsSavingProfile(false)
    }
  }

  async function handlePasswordChange(event) {
    event.preventDefault()
    const form = event.currentTarget
    if (!authUser?.email) {
      setFormMessage({ type: 'error', text: 'A signed-in email account is required to change the password.' })
      return
    }

    const formData = new FormData(form)
    const currentPassword = String(formData.get('currentPassword') ?? '')
    const newPassword = String(formData.get('newPassword') ?? '')
    const confirmPassword = String(formData.get('confirmPassword') ?? '')
    if (newPassword !== confirmPassword) {
      setFormMessage({ type: 'error', text: 'The new password and confirmation do not match.' })
      return
    }

    setIsChangingPassword(true)
    setFormMessage(null)
    try {
      const credential = EmailAuthProvider.credential(authUser.email, currentPassword)
      await reauthenticateWithCredential(authUser, credential)
      await updatePassword(authUser, newPassword)
      form.reset()
      setFormMessage({ type: 'success', text: 'Password changed successfully.' })
    } catch (error) {
      setFormMessage({ type: 'error', text: getFirebaseErrorMessage(error) })
    } finally {
      setIsChangingPassword(false)
    }
  }

  async function handleProfilePhotoChange(event) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file || !authUser) return

    try {
      const photoData = await createLocalProfilePhoto(file)
      window.localStorage.setItem(`msvportal.profilePhoto.${authUser.uid}`, photoData)
      setProfilePhoto(photoData)
      setFormMessage({ type: 'success', text: 'Profile photo saved in this browser.' })
    } catch (error) {
      setFormMessage({
        type: 'error',
        text: error instanceof DOMException && error.name === 'QuotaExceededError'
          ? 'This browser does not have enough local storage for the profile photo.'
          : error.message || 'Could not save the selected profile photo.',
      })
    }
  }

  function handleRemoveProfilePhoto() {
    if (!authUser) return
    try {
      window.localStorage.removeItem(`msvportal.profilePhoto.${authUser.uid}`)
      setProfilePhoto('')
      setFormMessage({ type: 'success', text: 'Profile photo removed from this browser.' })
    } catch {
      setFormMessage({ type: 'error', text: 'Could not remove the locally saved profile photo.' })
    }
  }

  function handleProfileClick() {
    if (!authUser) {
      setIsProfileMenuOpen(false)
      setActivePage('login')
      setFormMessage({ type: 'error', text: 'Please log in to access your account.' })
      setLoginAttention(true)
      setLoginAttentionCycle((cycle) => cycle + 1)
      return
    }

    setIsProfileMenuOpen((isOpen) => !isOpen)
  }

  function handlePageNavigation(pageId) {
    setFormMessage(null)
    if (!authUser && pageId !== 'login' && pageId !== 'signup') {
      setActivePage('login')
      setFormMessage({ type: 'error', text: 'Please log in first to access this page.' })
      return
    }
    if (pageId === 'approvals' && !isApprover(profile)) {
      if (authUser && profileLoading) {
        setActivePage(pageId)
        return
      }
      setFormMessage({ type: 'error', text: 'You are not authorized to view the Approve Request page.' })
      return
    }
    if (isApprover(profile) && ['requests', 'voucher'].includes(pageId)) {
      setFormMessage({ type: 'error', text: 'Managers cannot access My Requests or Request Voucher.' })
      return
    }
    if ((pageId === 'requests' || pageId === 'voucher') && !authUser) {
      setActivePage('login')
      const action = pageId === 'requests' ? 'view your requests' : 'request a voucher'
      setFormMessage({ type: 'error', text: `Please log in first to ${action}.` })
      return
    }

    if (pageId === 'requests' && pageId !== activePage) setRequestsLoading(true)
    if (pageId === 'approvals' && pageId !== activePage) setApprovalsLoading(true)
    setActivePage(pageId)
  }

  function handleBackNavigation() {
    const previousPage = pageHistoryRef.current.pop() ?? 'login'
    setFormMessage(null)
    if (previousPage === 'requests') setRequestsLoading(true)
    if (previousPage === 'approvals') setApprovalsLoading(true)
    setActivePage(previousPage, { replace: true, track: false })
  }

  async function handleLogout() {
    if (authUser) await signOut(auth)
    pageHistoryRef.current = []
    setActivePage('login')
    setIsProfileMenuOpen(false)
    setFormMessage(null)
  }

  function handleOpenProfile() {
    setIsProfileMenuOpen(false)
    setFormMessage(null)
    navigate(getProfilePath(profile, authUser), {
      flushSync: true,
      state: { profile, email: authUser?.email },
    })
  }

  function handleHomeNavigation() {
    setActivePage('login')
  }

  const profileName = profile?.name ?? authUser?.email ?? 'User'
  const deniedDirectPage = authUser && !profileLoading && (
    (isApprover(profile) && ['requests', 'voucher'].includes(activePage))
    || (!isApprover(profile) && activePage === 'approvals')
  )

  return (
    <main className="portal">
      <header className="portal-header">
        <div className="company-mark">Infosys <span>| ETA</span></div>
        <h1>Microsoft Voucher Portal</h1>
        {activePage !== 'signup' && (
          <div className="profile-area" ref={profileAreaRef}>
            <button
              className="profile-button"
              type="button"
              aria-label={authUser ? `Open profile menu for ${profileName}` : 'Go to login'}
              aria-haspopup={authUser ? 'menu' : undefined}
              aria-expanded={authUser ? isProfileMenuOpen : undefined}
              aria-controls={authUser ? 'profile-menu' : undefined}
              onClick={handleProfileClick}
            >
              <svg viewBox="0 0 32 32" aria-hidden="true">
                <circle cx="16" cy="10" r="6" />
                <path d="M4 29c0-7 5-11 12-11s12 4 12 11" />
              </svg>
            </button>
            {authUser && (
              <span className="profile-welcome">
                Welcome<br />{profileName}
              </span>
            )}
            {authUser && isProfileMenuOpen && (
              <div className="profile-menu" id="profile-menu" role="menu">
                <button className="profile-menu-item" type="button" role="menuitem" onClick={handleOpenProfile}>
                  Profile
                </button>
                <button className="profile-menu-item" type="button" role="menuitem" onClick={handleLogout}>
                  Logout
                </button>
              </div>
            )}
          </div>
        )}
      </header>

      {activePage !== 'signup' && activePage !== 'profile' && (
        <nav className="portal-nav" aria-label="Voucher portal pages">
          {['requests', 'voucher', 'approvals'].includes(activePage) && (
            <button
              className="page-back-button"
              type="button"
              aria-label="Go back to the previous page"
              title="Back"
              onClick={handleBackNavigation}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m15 18-6-6 6-6" />
              </svg>
            </button>
          )}
          {pages.map((page) => (
            <button
              className={`nav-button${activePage === page.id ? ' is-active' : ''}`}
              type="button"
              key={page.id}
              aria-current={activePage === page.id ? 'page' : undefined}
              onClick={() => handlePageNavigation(page.id)}
            >
              <span className={`nav-icon nav-icon-${page.id}`} aria-hidden="true">{page.icon}</span>
              {page.label}
            </button>
          ))}
        </nav>
      )}

      <section className="portal-content">
        <div className="form-message-slot" aria-live="polite">
          {formMessage && (
            <p
              className={`form-message form-message-${formMessage.type}${dismissingMessage === formMessage ? ' is-dismissing' : ''}`}
              role={formMessage.type === 'error' ? 'alert' : 'status'}
              aria-live={formMessage.type === 'error' ? 'assertive' : 'polite'}
            >
              <svg className="form-message-icon" viewBox="0 0 20 20" aria-hidden="true">
                {formMessage.type === 'error' ? (
                  <>
                    <circle cx="10" cy="10" r="8" />
                    <path d="M10 5.5v5M10 13.5v1" />
                  </>
                ) : (
                  <>
                    <circle cx="10" cy="10" r="8" />
                    <path d="m6 10 2.5 2.5L14.5 7" />
                  </>
                )}
              </svg>
              {formMessage.text}
            </p>
          )}
        </div>
        {deniedDirectPage ? (
          <p className="requests-empty" role="alert">
            {isApprover(profile)
              ? 'Managers cannot access My Requests or Request Voucher.'
              : 'You are not authorized to view the Approve Request page.'}
          </p>
        ) : activePage === 'login' ? (
          <>
            <p className="notice">
              Once a voucher is allocated, it is valid as per the allocation mailer and can be used only once.<br />
              To see the system requirements for taking exam from home, please visit the FAQ page.
            </p>
            {!authUser && (
              <>
                <form
                  className="login-form"
                  autoComplete="off"
                  onSubmit={(event) => {
                    setLoginAttention(false)
                    handleLogin(event)
                  }}
                >
                  <label htmlFor="login-email">Email ID:</label>
                  <input
                    id="login-email"
                    ref={loginEmailRef}
                    name="email"
                    type="email"
                    autoComplete="email"
                    placeholder="Enter Email ID"
                    required
                    onChange={() => setLoginAttention(false)}
                  />
                  <label htmlFor="password">Password:</label>
                  <input id="password" name="password" type="password" autoComplete="current-password" placeholder="Enter Password" required />
                  <span aria-hidden="true" />
                  <div className="login-actions">
                    <button
                      key={loginAttentionCycle}
                      className={`login-button${loginAttention ? ' login-button-attention' : ''}`}
                      type="submit"
                    >
                      LogIn
                    </button>
                    <button className="signup-button" type="button" onClick={() => setActivePage('signup')}>
                      Sign Up
                    </button>
                  </div>
                </form>
              </>
            )}
            <button className="faq-button" type="button" disabled>FAQ Page</button>
          </>
        ) : activePage === 'requests' ? (
          <section className="requests-page" aria-labelledby="requests-title">
            <h2 className="requests-title" id="requests-title">My Voucher Requests</h2>
            <section className="request-group" aria-labelledby="pending-requests-title">
              <div className="request-group-heading">
                <h3 id="pending-requests-title">Pending Requests</h3>
                <span>{voucherRequests.filter((request) => (request.status ?? 'pending') === 'pending').length}</span>
              </div>
              {requestsLoading ? (
                <p className="requests-empty" role="status">Loading requests...</p>
              ) : voucherRequests.filter((request) => (request.status ?? 'pending') === 'pending').length === 0 ? (
                <p className="requests-empty">No pending requests.</p>
              ) : (
                <div className="requests-table-wrap">
                  <table className="requests-table">
                    <thead>
                      <tr>
                        <th scope="col">Reference Number</th>
                        <th scope="col">Request Date</th>
                        <th scope="col">Location</th>
                        <th scope="col">Certification Code</th>
                        <th scope="col">Status</th>
                        <th scope="col">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {voucherRequests.filter((request) => (request.status ?? 'pending') === 'pending').map((request) => (
                        <tr key={request.id}>
                          <td>{request.referenceNumber ?? 'Not assigned'}</td>
                          <td>{formatRequestDate(request.createdAt)}</td>
                          <td>{request.employeeLocation}</td>
                          <td>{request.certificationCode}</td>
                          <td><span className="request-status">pending</span></td>
                          <td>
                            <button
                              className="cancel-request-button"
                              type="button"
                              disabled={cancelingRequestId === request.id}
                              onClick={() => handleCancelRequest(request)}
                            >
                              {cancelingRequestId === request.id ? 'Deleting...' : 'Cancel'}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            <section className="request-group" aria-labelledby="closed-requests-title">
              <div className="request-group-heading">
                <h3 id="closed-requests-title">My Closed Requests</h3>
                <span>{voucherRequests.filter((request) => ['approved', 'rejected'].includes(request.status)).length}</span>
              </div>
              {requestsLoading ? (
                <p className="requests-empty" role="status">Loading requests...</p>
              ) : voucherRequests.filter((request) => ['approved', 'rejected'].includes(request.status)).length === 0 ? (
                <p className="requests-empty">No closed requests.</p>
              ) : (
                <div className="requests-table-wrap">
                  <table className="requests-table">
                    <thead>
                      <tr>
                        <th scope="col">Reference Number</th>
                        <th scope="col">Request Date</th>
                        <th scope="col">Location</th>
                        <th scope="col">Certification Code</th>
                        <th scope="col">Status</th>
                        <th scope="col">Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {voucherRequests.filter((request) => ['approved', 'rejected'].includes(request.status)).map((request) => (
                        <Fragment key={request.id}>
                          <tr>
                            <td>{request.referenceNumber ?? 'Not assigned'}</td>
                            <td>{formatRequestDate(request.createdAt)}</td>
                            <td>{request.employeeLocation}</td>
                            <td>{request.certificationCode}</td>
                            <td><span className={`request-status request-status-${request.status}`}>{request.status}</span></td>
                            <td>
                              {request.status === 'rejected' && (
                                <button
                                  className="view-voucher-details-button"
                                  type="button"
                                  aria-expanded={expandedRequestId === request.id}
                                  aria-controls={`request-remarks-${request.id}`}
                                  onClick={() => setExpandedRequestId((currentId) => currentId === request.id ? null : request.id)}
                                >
                                  {expandedRequestId === request.id ? 'Hide Remarks' : 'View Remarks'}
                                </button>
                              )}
                              {request.status === 'approved' && request.voucherCode && (
                                <button
                                  className="view-voucher-details-button"
                                  type="button"
                                  aria-expanded={expandedRequestId === request.id}
                                  aria-controls={`voucher-code-${request.id}`}
                                  onClick={() => {
                                    setExpandedRequestId((currentId) => currentId === request.id ? null : request.id)
                                    setCopiedVoucherCode(null)
                                  }}
                                >
                                  {expandedRequestId === request.id ? 'Hide Details' : 'View Details'}
                                </button>
                              )}
                            </td>
                          </tr>
                          {request.status === 'approved' && request.voucherCode && expandedRequestId === request.id && (
                            <tr className="voucher-code-row" id={`voucher-code-${request.id}`}>
                              <td colSpan={6}>
                                <div className="voucher-code-details">
                                  <span>Voucher Code</span>
                                  <code>{request.voucherCode}</code>
                                  <button
                                    className="copy-voucher-code-button"
                                    type="button"
                                    aria-label={copiedVoucherCode === request.voucherCode ? 'Voucher code copied' : 'Copy voucher code'}
                                    title={copiedVoucherCode === request.voucherCode ? 'Copied' : 'Copy voucher code'}
                                    onClick={() => handleCopyVoucherCode(request.voucherCode)}
                                  >
                                    {copiedVoucherCode === request.voucherCode ? (
                                      <svg viewBox="0 0 24 24" aria-hidden="true">
                                        <path d="m5 12 4 4L19 6" />
                                      </svg>
                                    ) : (
                                      <svg viewBox="0 0 24 24" aria-hidden="true">
                                        <rect x="8" y="8" width="12" height="13" rx="1.5" />
                                        <path d="M16 8V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h2" />
                                      </svg>
                                    )}
                                  </button>
                                </div>
                              </td>
                            </tr>
                          )}
                          {request.status === 'rejected' && expandedRequestId === request.id && (
                            <tr className="request-remarks-row" id={`request-remarks-${request.id}`}>
                              <td colSpan={6}>
                                <div className="request-remarks-details">
                                  <span>Rejection Remarks</span>
                                  <p>{request.rejectionRemarks || 'No rejection remarks were provided.'}</p>
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </section>
        ) : activePage === 'approvals' ? (
          <section className="requests-page" aria-labelledby="approvals-title">
            <h2 className="requests-title" id="approvals-title">Pending Voucher Approvals</h2>
            {approvalsLoading ? (
              <p className="requests-empty" role="status">Loading pending requests...</p>
            ) : approvalRequests.length === 0 ? (
              <p className="requests-empty">No requests awaiting approval.</p>
            ) : (
              <div className="requests-table-wrap">
                <table className="requests-table approvals-table">
                  <thead>
                    <tr>
                      <th scope="col">Requester</th>
                      <th scope="col">Request Date</th>
                      <th scope="col">Location</th>
                      <th scope="col">Certification Code</th>
                      <th scope="col">Status</th>
                      <th scope="col">Decision</th>
                    </tr>
                  </thead>
                  <tbody>
                    {approvalRequests.map((request) => (
                      <Fragment key={request.id}>
                      <tr>
                        <td>{request.employeeName}</td>
                        <td>{formatRequestDate(request.createdAt)}</td>
                        <td>{request.employeeLocation}</td>
                        <td>{request.certificationCode}</td>
                        <td><span className="request-status">pending</span></td>
                        <td className="approval-actions">
                          <button
                            className="approve-request-button"
                            type="button"
                            disabled={reviewingRequestId === request.id}
                            onClick={() => handleReviewRequest(request, 'approved')}
                          >
                            Approve
                          </button>
                          <button
                            className="reject-request-button"
                            type="button"
                            disabled={reviewingRequestId === request.id}
                            aria-expanded={rejectionDraftRequestId === request.id}
                            aria-controls={`rejection-remarks-${request.id}`}
                            onClick={() => {
                              setRejectionDraftRequestId((currentId) => currentId === request.id ? null : request.id)
                              setRejectionRemarks('')
                            }}
                          >
                            Reject
                          </button>
                        </td>
                      </tr>
                      {rejectionDraftRequestId === request.id && (
                        <tr className="rejection-remarks-row" id={`rejection-remarks-${request.id}`}>
                          <td colSpan={6}>
                            <div className="rejection-remarks-form">
                              <label htmlFor={`rejection-remarks-input-${request.id}`}>Rejection remarks</label>
                              <textarea
                                id={`rejection-remarks-input-${request.id}`}
                                rows={2}
                                maxLength={1000}
                                value={rejectionRemarks}
                                onChange={(event) => setRejectionRemarks(event.target.value)}
                                placeholder="Add a reason for rejecting this request"
                              />
                              <div className="rejection-remarks-actions">
                                <button
                                  className="cancel-request-button"
                                  type="button"
                                  onClick={() => {
                                    setRejectionDraftRequestId(null)
                                    setRejectionRemarks('')
                                  }}
                                >
                                  Cancel
                                </button>
                                <button
                                  className="reject-request-button"
                                  type="button"
                                  disabled={reviewingRequestId === request.id || !rejectionRemarks.trim()}
                                  onClick={() => handleReviewRequest(request, 'rejected', rejectionRemarks)}
                                >
                                  {reviewingRequestId === request.id ? 'Rejecting...' : 'Confirm Reject'}
                                </button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ) : activePage === 'profile' ? (
          <>
            <section className="profile-layout" aria-label="Account settings">
              <aside className="profile-sidebar">
                <div className="profile-photo-section">
                  <button
                    className="profile-avatar-button"
                    type="button"
                    aria-label={profilePhoto ? 'View profile photo' : 'Add profile photo'}
                    onClick={() => profilePhoto
                      ? setIsProfilePhotoPreviewOpen(true)
                      : profilePhotoInputRef.current?.click()}
                  >
                    {profilePhoto ? (
                      <img src={profilePhoto} alt="" />
                    ) : (
                      <svg viewBox="0 0 48 48" aria-hidden="true">
                        <circle cx="24" cy="16" r="9" />
                        <path d="M6 44c0-10 7-16 18-16s18 6 18 16" />
                      </svg>
                    )}
                  </button>
                  <input
                    ref={profilePhotoInputRef}
                    className="visually-hidden"
                    type="file"
                    accept="image/*"
                    aria-label="Choose profile photo from this device"
                    onChange={handleProfilePhotoChange}
                  />
                  <button
                    className="profile-photo-action"
                    type="button"
                    onClick={() => profilePhotoInputRef.current?.click()}
                  >
                    {profilePhoto ? 'Change photo' : 'Add photo'}
                  </button>
                  {profilePhoto && (
                    <button className="profile-photo-remove" type="button" onClick={handleRemoveProfilePhoto}>
                      Remove photo
                    </button>
                  )}
                  <p className="profile-photo-note">Optional · saved in this browser only</p>
                </div>
                {profilePhoto && (
                  <dialog
                    ref={profilePhotoPreviewRef}
                    className="profile-photo-preview"
                    aria-label="Profile photo preview"
                    onCancel={(event) => {
                      event.preventDefault()
                      setIsProfilePhotoPreviewOpen(false)
                    }}
                    onClose={() => setIsProfilePhotoPreviewOpen(false)}
                    onClick={(event) => {
                      if (event.target === event.currentTarget) {
                        setIsProfilePhotoPreviewOpen(false)
                      }
                    }}
                  >
                    <button
                      className="profile-photo-preview-close"
                      type="button"
                      aria-label="Close photo preview"
                      onClick={() => setIsProfilePhotoPreviewOpen(false)}
                    >
                      ×
                    </button>
                    <img src={profilePhoto} alt="Profile photo enlarged" />
                  </dialog>
                )}
                <nav className="profile-section-nav" aria-label="Profile sections">
                  <button
                    className={`profile-section-button${profileSection === 'details' ? ' is-active' : ''}`}
                    type="button"
                    aria-current={profileSection === 'details' ? 'page' : undefined}
                    onClick={() => {
                      setProfileSection('details')
                      setIsEditingProfile(false)
                    }}
                  >
                    My Profile
                  </button>
                  <button
                    className={`profile-section-button${profileSection === 'password' ? ' is-active' : ''}`}
                    type="button"
                    aria-current={profileSection === 'password' ? 'page' : undefined}
                    onClick={() => {
                      setProfileSection('password')
                      setIsEditingProfile(false)
                    }}
                  >
                    Change Password
                  </button>
                </nav>
              </aside>

              <div className="profile-main-panel">
                {profileSection === 'details' ? (
                  <>
                    <div className="profile-panel-heading">
                      <h2 id="account-profile-title">My Profile</h2>
                      {!isEditingProfile && !profileLoading && profile && (
                        <button
                          className="profile-edit-button"
                          type="button"
                          aria-label="Edit profile details"
                          title="Edit profile details"
                          onClick={() => setIsEditingProfile(true)}
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="m14 5 5 5M4 20l4.5-1 11-11a2.1 2.1 0 0 0-3-3l-11 11z" />
                          </svg>
                        </button>
                      )}
                    </div>
                    {profileLoading ? (
                      <p className="profile-loading" role="status">Loading profile...</p>
                    ) : !profile ? (
                      <p className="profile-loading" role="alert">Profile details are unavailable.</p>
                    ) : isEditingProfile ? (
                      <form className="profile-details-form" onSubmit={handleProfileSave}>
                        <label htmlFor="profile-name">Name</label>
                        <input id="profile-name" name="name" type="text" defaultValue={profile.name ?? ''} maxLength={100} required />

                        <label htmlFor="profile-email">Email ID</label>
                        <output className="profile-readonly-value" id="profile-email">{authUser?.email ?? 'Not provided'}</output>

                        <label htmlFor="profile-employee-id">Employee ID</label>
                        <input
                          id="profile-employee-id"
                          name="employeeId"
                          type="text"
                          inputMode="numeric"
                          pattern="[0-9]{7}"
                          defaultValue={profile.employeeId ?? ''}
                          onChange={handleEmployeeIdInput}
                          title="Enter exactly 7 digits"
                          required
                        />

                        <label htmlFor="profile-location">Location</label>
                        <select id="profile-location" name="location" defaultValue={profile.location ?? ''} required>
                          <option value="" disabled>Select location</option>
                          {locations.map((availableLocation) => <option key={availableLocation}>{availableLocation}</option>)}
                        </select>

                        <span aria-hidden="true" />
                        <div className="profile-form-actions">
                          <button className="profile-save-button" type="submit" disabled={isSavingProfile}>
                            {isSavingProfile ? 'Saving...' : 'Save changes'}
                          </button>
                          <button
                            className="profile-cancel-button"
                            type="button"
                            disabled={isSavingProfile}
                            onClick={() => setIsEditingProfile(false)}
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    ) : (
                      <dl className="account-profile-details">
                        <div><dt>Name</dt><dd>{profile.name ?? 'Not provided'}</dd></div>
                        <div><dt>Email ID</dt><dd>{authUser?.email ?? 'Not provided'}</dd></div>
                        <div><dt>Employee ID</dt><dd>{profile.employeeId ?? 'Not provided'}</dd></div>
                        <div><dt>Location</dt><dd>{profile.location ?? 'Not provided'}</dd></div>
                      </dl>
                    )}
                  </>
                ) : (
                  <>
                    <div className="profile-panel-heading">
                      <h2>Change Password</h2>
                    </div>
                    <form className="password-change-form" onSubmit={handlePasswordChange}>
                      <label htmlFor="current-password">Current password</label>
                      <input
                        id="current-password"
                        name="currentPassword"
                        type="password"
                        autoComplete="current-password"
                        required
                      />

                      <label htmlFor="new-password">New password</label>
                      <input
                        id="new-password"
                        name="newPassword"
                        type="password"
                        autoComplete="new-password"
                        minLength={8}
                        pattern="(?=.*[A-Za-z])(?=.*[0-9])(?=.*[^A-Za-z0-9]).{8,}"
                        title="Use at least 8 characters with a letter, a number, and a special character"
                        required
                      />

                      <label htmlFor="confirm-password">Confirm new password</label>
                      <input
                        id="confirm-password"
                        name="confirmPassword"
                        type="password"
                        autoComplete="new-password"
                        minLength={8}
                        pattern="(?=.*[A-Za-z])(?=.*[0-9])(?=.*[^A-Za-z0-9]).{8,}"
                        title="Use at least 8 characters with a letter, a number, and a special character"
                        required
                      />

                      <button className="profile-save-button" type="submit" disabled={isChangingPassword}>
                        {isChangingPassword ? 'Updating...' : 'Update password'}
                      </button>
                    </form>
                  </>
                )}
              </div>
            </section>
            <button className="home-button" type="button" aria-label="Go to home page" onClick={handleHomeNavigation}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z" />
              </svg>
            </button>
          </>
        ) : activePage === 'voucher' ? (
          <>
            <h2 className="voucher-title">Request For a New Voucher</h2>
            <p className="voucher-warning">
              Raise a Voucher request only if you are ready to take the exam within 2 weeks.
            </p>
            <form className="voucher-form" onSubmit={handleVoucherSubmit}>
              <label htmlFor="employee-id">Employee Id:</label>
              <output className="voucher-readonly-value" id="employee-id">{profile?.employeeId ?? ''}</output>

              <label htmlFor="employee-name">Employee Name:</label>
              <output className="voucher-readonly-value" id="employee-name">{profile?.name ?? ''}</output>

              <label htmlFor="employee-email">Employee Email:</label>
              <output className="voucher-readonly-value" id="employee-email">{authUser?.email ?? ''}</output>

              <label htmlFor="employee-location">Employee Location:</label>
              <select id="employee-location" name="employeeLocation" defaultValue="" required>
                <option value="" disabled>Select location</option>
                {locations.map((location) => <option key={location}>{location}</option>)}
              </select>

              <label htmlFor="certification-code">Certification Code:</label>
              <select id="certification-code" name="certificationCode" defaultValue="PL-500">
                {certifications.map((certification) => (
                  <option key={certification}>{certification}</option>
                ))}
              </select>

              <label htmlFor="remarks">Remarks (optional):</label>
              <input id="remarks" name="remarks" type="text" />

              <span aria-hidden="true" />
              <button className="submit-request-button" type="submit">Submit Request</button>
            </form>
            <button className="home-button" type="button" aria-label="Back to login" onClick={() => setActivePage('login')}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z" />
              </svg>
            </button>
          </>
        ) : activePage === 'signup' ? (
          <>
            <button className="signup-back-button" type="button" onClick={() => setActivePage('login')}>
              <span aria-hidden="true">←</span> Back
            </button>
            <h2 className="signup-title">Sign Up</h2>
            <form className="signup-form" onSubmit={handleSignUp}>
              <label htmlFor="signup-name">Name:</label>
              <input id="signup-name" name="name" type="text" autoComplete="name" required />

              <label htmlFor="signup-location">Location:</label>
              <select id="signup-location" name="location" defaultValue="" required>
                <option value="" disabled>Select location</option>
                {locations.map((location) => <option key={location}>{location}</option>)}
              </select>

              <label htmlFor="signup-employee-id">Employee ID:</label>
              <input
                id="signup-employee-id"
                name="employeeId"
                type="text"
                inputMode="numeric"
                pattern="[0-9]{7}"
                onChange={handleEmployeeIdInput}
                title="Enter exactly 7 digits"
                required
              />

              <label htmlFor="signup-email">Email ID:</label>
              <input
                id="signup-email"
                name="email"
                type="email"
                autoComplete="email"
                pattern="[^\s@]+@[^\s@]+\.[^\s@]+"
                title="Enter an email address containing @ and a dot"
                required
              />

              <label htmlFor="signup-password">Password:</label>
              <input
                id="signup-password"
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                pattern="(?=.*[A-Za-z])(?=.*[0-9])(?=.*[^A-Za-z0-9]).{8,}"
                title="Use at least 8 characters with a letter, a number, and a special character"
                required
              />

              <span aria-hidden="true" />
              <button className="signup-submit-button" type="submit">Create Account</button>
            </form>
          </>
        ) : null}
      </section>
      {activePage === 'login' && (
        <footer className="portal-footer">
          <span>&copy; 2026 Microsoft Voucher Portal. All rights reserved.</span>
          <span>Developed by Hrishav</span>
        </footer>
      )}
    </main>
  )
}

export default App
