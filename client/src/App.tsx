import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useRef } from "react";
import { Provider as ReduxProvider } from "react-redux";
import { store } from "@/store";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConfirmProvider } from "@/components/ui/confirm-bar";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { useBrandSettings } from "@/hooks/use-brand-settings";
import { LayoutShell } from "@/components/layout-shell";
import { ProfilePhotoTransitionProvider } from "@/components/transition/profile-photo-transition";
import { VoiceSessionProvider } from "@/contexts/voice-session-context";
import { GlobalVoicePip } from "@/components/voice/GlobalVoicePip";
import { Loader2 } from "lucide-react";
import { hasProviderRole } from "@shared/roles";

import NotFound from "@/pages/not-found";
import AuthPage from "@/pages/auth-page";
import DashboardPage from "@/pages/dashboard-page";
import MarketplacePage from "@/pages/marketplace-page";
import AdminProvidersPage from "@/pages/admin-providers-page";
import AdminProviderEditPage from "@/pages/admin-provider-edit-page";
import AdminProviderAddPage from "@/pages/admin-provider-add-page";
import ProfileDetailPage from "@/pages/profile-detail-page";
import ProfileEditPage from "@/pages/profile-edit-page";
import StaffPage from "@/pages/staff-page";
import ParentDetailPage from "@/pages/parent-detail-page";
import AdminUserEditPage from "@/pages/admin-user-edit-page";
import AdminUserAddPage from "@/pages/admin-user-add-page";
import CompleteProfilePage from "@/pages/complete-profile-page";
import OnboardingPage from "@/pages/onboarding-page";
import AccountPage from "@/pages/account-page";
import CalendarPage from "@/pages/calendar-page";
import BookingPage from "@/pages/booking-page";
import BookingConfirmationPage from "@/pages/booking-confirmation-page";
import BookingActionPage from "@/pages/booking-action-page";
import BookingManagePage from "@/pages/booking-manage-page";
import ScrapersSummaryPage from "@/pages/scrapers-summary-page";
import ScraperReportPage from "@/pages/scraper-report-page";
import CdcSyncReportPage from "@/pages/cdc-sync-report-page";
import EnrichmentReportPage from "@/pages/enrichment-report-page";
import VideoRoomPage from "@/pages/video-room-page";
import RecordingPage from "@/pages/recording-page";
import ProviderProfilePage from "@/pages/provider-profile-page";
import DoctorProfilePage from "@/pages/doctor-profile-page";
import PerformancePage from "@/pages/performance-page";
import AdminAnalyticsPage from "@/pages/admin-analytics-page";
import AdminReviewsPage from "@/pages/admin-reviews-page";
import ParentNewAppointmentPage from "@/pages/parent-new-appointment-page";
import CdcClinicSuccessRatesPage from "@/pages/cdc-clinic-success-rates-page";
import ForgotPasswordPage from "@/pages/forgot-password-page";
import CheckEmailPage from "@/pages/check-email-page";
import SmsConsentPage from "@/pages/sms-consent-page";
import ResetPasswordPage from "@/pages/reset-password-page";
import MatchmakerSelectionPage from "@/pages/matchmaker-selection-page";
import ConciergeChatPage from "@/pages/concierge-chat-page";
import ConversationsPage from "@/pages/conversations-page";
import ChatSessionRedirect from "@/pages/chat-session-redirect";
import AdminConciergeMonitor from "@/pages/admin-concierge-monitor";
import OnboardingAiIntroPage from "@/pages/onboarding-ai-intro-page";
import OnboardingAiReadyPage from "@/pages/onboarding-ai-ready-page";
import AgreementsSigningPage from "@/pages/agreements-signing-page";
import AgreementsGuestSigningPage from "@/pages/agreements-guest-signing-page";
import IpFormPage from "@/pages/ip-form-page";
import IpFormGuestPage from "@/pages/ip-form-guest-page";
import ProviderParentFormsPage from "@/pages/provider-parent-forms-page";
import W9SigningPage from "@/pages/w9-signing-page";
import ProviderAgreementSigningPage from "@/pages/provider-agreement-signing-page";
import PaymentPage from "@/pages/payment-page";
import AdminBillingPage from "@/pages/admin-billing-page";
import AdminSecurityPage from "@/pages/admin-security-page";
import MyInvoicesPage from "@/pages/my-invoices-page";
import ParentHomePage from "@/pages/parent-home-page";
import MyCostSheetsPage from "@/pages/my-cost-sheets-page";
import ProviderPayoutsPage from "@/pages/provider-payouts-page";
import ProviderCostSheetsPage from "@/pages/provider-cost-sheets-page";
import ProviderAgreementsPage from "@/pages/provider-agreements-page";
import ProviderHomePage from "@/pages/provider-home-page";
import AdminHomePage from "@/pages/admin-home-page";
import AdminAgreementsPage from "@/pages/admin-agreements-page";
import ProviderBillingPage from "@/pages/provider-billing-page";

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  const location = useLocation();
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }
  if (!user) return <Navigate to="/" replace state={{ returnTo: location.pathname + location.search }} />;
  if (user.mustCompleteProfile && !hasProviderRole(user.roles || [])) return <Navigate to="/onboarding" replace />;
  return <>{children}</>;
}

function OnboardingGuard({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }
  if (!user) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function DashboardRoute() {
  const { user } = useAuth();
  const roles = (user as any)?.roles || [];
  const isParent = roles.includes('PARENT');
  const isAdmin = roles.includes('GOSTORK_ADMIN');
  const isProvider = hasProviderRole(roles);
  const isParentOnly = isParent && !isAdmin && !isProvider;

  // Parents and providers land in chat regardless of concierge brand settings;
  // GoStork admins land on the command center. A provider's FIRST-EVER login
  // (fresh from the welcome email's set-password link - lastLoginAt is
  // stamped after the response, so it is still null here) lands on My
  // Account so they start from their own settings, not an empty chat.
  if (isParentOnly) return <Navigate to="/chat" replace />;
  if (isAdmin) return <Navigate to="/admin/home" replace />;
  if (isProvider && !(user as any)?.lastLoginAt) return <Navigate to="/account" replace />;
  if (isProvider) return <Navigate to="/chat" replace />;
  return <Navigate to="/marketplace" replace />;
}

/**
 * Global filter persistence: every page keeps its filters, tabs, and sort
 * state in URL search params, so remembering the last search string per path
 * makes EVERY filter on the platform sticky - leave a page and come back and
 * it looks exactly as you left it.
 *
 * Rules:
 *  - Arriving on a path WITH params saves them (deep links behave normally).
 *  - Changing params on the same page saves the new state - including
 *    clearing them, so "reset filters" stays reset.
 *  - Arriving on a path WITHOUT params restores the saved state, if any.
 * sessionStorage scope: per browser tab, gone when the tab closes - sticky
 * enough for a work session without resurrecting week-old filters.
 * Auth/guest flows are excluded - a restored ?returnTo= or token param
 * there could misroute a login.
 */
const FILTER_PERSIST_EXCLUDED = ["/auth", "/login", "/reset-password", "/complete-profile", "/sign-agreement", "/sign-w9", "/agreements/guest", "/onboarding", "/"];

function FilterPersistence() {
  const location = useLocation();
  const navigate = useNavigate();
  const prevPathRef = useRef<string | null>(null);

  useEffect(() => {
    const path = location.pathname;
    const excluded = FILTER_PERSIST_EXCLUDED.some(p => p === "/" ? path === "/" : path === p || path.startsWith(`${p}/`));
    if (excluded) { prevPathRef.current = path; return; }
    const key = `pagefilters:${path}`;
    const samePage = prevPathRef.current === path;
    prevPathRef.current = path;
    try {
      if (location.search) {
        sessionStorage.setItem(key, location.search);
      } else if (samePage) {
        // The user cleared the params on this page - remember "cleared".
        sessionStorage.setItem(key, "");
      } else {
        const saved = sessionStorage.getItem(key);
        if (saved) navigate({ pathname: path, search: saved }, { replace: true });
      }
    } catch { /* storage unavailable (private mode) - filters just don't stick */ }
  }, [location.pathname, location.search, navigate]);

  return null;
}

function AppRoutes() {
  useBrandSettings();

  return (
    <LayoutShell>
      <FilterPersistence />
      <Routes>
        <Route path="/" element={<AuthPage />} />
        <Route path="/login" element={<AuthPage />} />
        <Route path="/auth" element={<AuthPage />} />
        <Route path="/sms-consent" element={<SmsConsentPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/check-email" element={<CheckEmailPage />} />
        <Route path="/reset-password/:token" element={<ResetPasswordPage />} />
        <Route path="/complete-profile" element={<CompleteProfilePage />} />
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route path="/onboarding/ai-intro" element={<OnboardingGuard><OnboardingAiIntroPage /></OnboardingGuard>} />
        <Route path="/onboarding/ai-ready" element={<OnboardingGuard><OnboardingAiReadyPage /></OnboardingGuard>} />
        <Route path="/dashboard" element={<ProtectedRoute><DashboardRoute /></ProtectedRoute>} />
        <Route path="/marketplace" element={<ProtectedRoute><MarketplacePage /></ProtectedRoute>} />
        <Route path="/performance" element={<ProtectedRoute><PerformancePage /></ProtectedRoute>} />
        <Route path="/providers/:id" element={<ProtectedRoute><ProviderProfilePage /></ProtectedRoute>} />
        <Route path="/doctors/:slug" element={<ProtectedRoute><DoctorProfilePage /></ProtectedRoute>} />
        <Route path="/admin/providers/new" element={<ProtectedRoute><AdminProviderAddPage /></ProtectedRoute>} />
        <Route path="/admin/providers/:id" element={<ProtectedRoute><AdminProviderEditPage /></ProtectedRoute>} />
        <Route path="/eggdonor/:providerId/:donorId" element={<ProtectedRoute><ProfileDetailPage /></ProtectedRoute>} />
        <Route path="/surrogate/:providerId/:donorId" element={<ProtectedRoute><ProfileDetailPage /></ProtectedRoute>} />
        <Route path="/spermdonor/:providerId/:donorId" element={<ProtectedRoute><ProfileDetailPage /></ProtectedRoute>} />
        <Route path="/admin/providers/:providerId/eggdonor/:donorId" element={<ProtectedRoute><ProfileDetailPage /></ProtectedRoute>} />
        <Route path="/admin/providers/:providerId/surrogate/:donorId" element={<ProtectedRoute><ProfileDetailPage /></ProtectedRoute>} />
        <Route path="/admin/providers/:providerId/spermdonor/:donorId" element={<ProtectedRoute><ProfileDetailPage /></ProtectedRoute>} />
        <Route path="/admin/providers/:providerId/eggdonor/:donorId/edit" element={<ProtectedRoute><ProfileEditPage /></ProtectedRoute>} />
        <Route path="/admin/providers/:providerId/surrogate/:donorId/edit" element={<ProtectedRoute><ProfileEditPage /></ProtectedRoute>} />
        <Route path="/admin/providers/:providerId/spermdonor/:donorId/edit" element={<ProtectedRoute><ProfileEditPage /></ProtectedRoute>} />
        {/* Legacy redirects */}
        <Route path="/donors/:type/:providerId/:donorId" element={<ProtectedRoute><ProfileDetailPage /></ProtectedRoute>} />
        <Route path="/admin/providers/:providerId/donors/:type/:donorId" element={<ProtectedRoute><ProfileDetailPage /></ProtectedRoute>} />
        <Route path="/admin/providers/:providerId/donors/:type/:donorId/edit" element={<ProtectedRoute><ProfileEditPage /></ProtectedRoute>} />
        <Route path="/admin/providers" element={<ProtectedRoute><AdminProvidersPage /></ProtectedRoute>} />
        <Route path="/admin/scrapers" element={<ProtectedRoute><ScrapersSummaryPage /></ProtectedRoute>} />
        <Route path="/admin/scrapers/report/:providerId/:type" element={<ProtectedRoute><ScraperReportPage /></ProtectedRoute>} />
        <Route path="/admin/scrapers/cdc-sync/:id/report" element={<ProtectedRoute><CdcSyncReportPage /></ProtectedRoute>} />
        <Route path="/admin/scrapers/cdc-sync/:id/enrichment-report" element={<ProtectedRoute><EnrichmentReportPage /></ProtectedRoute>} />
        <Route path="/admin/scrapers/cdc-sync/:id/clinic/:providerId" element={<ProtectedRoute><CdcClinicSuccessRatesPage /></ProtectedRoute>} />
        <Route path="/users/new" element={<ProtectedRoute><AdminUserAddPage /></ProtectedRoute>} />
        <Route path="/users/:id" element={<ProtectedRoute><AdminUserEditPage /></ProtectedRoute>} />
        <Route path="/parents" element={<ProtectedRoute><StaffPage /></ProtectedRoute>} />
        <Route path="/users" element={<Navigate to="/parents" replace />} />
        <Route path="/parents/:id" element={<ProtectedRoute><ParentDetailPage /></ProtectedRoute>} />
        <Route path="/provider/services" element={<Navigate to="/account/company" replace />} />
        <Route path="/calendar" element={<ProtectedRoute><CalendarPage /></ProtectedRoute>} />
        <Route path="/calendar/new-appointment" element={<ProtectedRoute><ParentNewAppointmentPage /></ProtectedRoute>} />
        <Route path="/appointments" element={<Navigate to="/calendar" replace />} />
        <Route path="/matchmaker-selection" element={<OnboardingGuard><MatchmakerSelectionPage /></OnboardingGuard>} />
        <Route path="/concierge" element={<ProtectedRoute><ConciergeChatPage /></ProtectedRoute>} />
        <Route path="/chat" element={<ProtectedRoute><ConversationsPage /></ProtectedRoute>} />
        <Route path="/chat/concierge" element={<ProtectedRoute><ConversationsPage /></ProtectedRoute>} />
        <Route path="/chat/:entityId/:subjectId" element={<ProtectedRoute><ConversationsPage /></ProtectedRoute>} />
        <Route path="/chat/:sessionId" element={<ProtectedRoute><ChatSessionRedirect /></ProtectedRoute>} />
        <Route path="/agreements/:id" element={<ProtectedRoute><AgreementsSigningPage /></ProtectedRoute>} />
        <Route path="/agreements/guest/:token" element={<AgreementsGuestSigningPage />} />
        <Route path="/ip-form" element={<ProtectedRoute><IpFormPage /></ProtectedRoute>} />
        {/* Public guest signing for the second intended parent - no auth */}
        <Route path="/ip-form/guest/:token" element={<IpFormGuestPage />} />
        <Route path="/provider/parent-forms" element={<ProtectedRoute><ProviderParentFormsPage /></ProtectedRoute>} />
        {/* Template editor lives under account settings; keep the old URL working */}
        <Route path="/admin/ip-form-template" element={<Navigate to="/account/ip-form-template" replace />} />
        <Route path="/w9/:id" element={<ProtectedRoute><W9SigningPage /></ProtectedRoute>} />
        {/* Login-free W-9 guest signing (token-gated, public). */}
        <Route path="/sign-w9/:token" element={<W9SigningPage />} />
        <Route path="/provider-agreement/:id" element={<ProtectedRoute><ProviderAgreementSigningPage /></ProtectedRoute>} />
        {/* Login-free guest signing: providers sign BEFORE first login (token-gated, public). */}
        <Route path="/sign-agreement/:token" element={<ProviderAgreementSigningPage />} />
        {/* Public payment page - no auth required */}
        <Route path="/pay/:paymentToken" element={<PaymentPage />} />
        {/* Billing routes */}
        <Route path="/admin/billing" element={<ProtectedRoute><AdminBillingPage /></ProtectedRoute>} />
        <Route path="/my/invoices" element={<ProtectedRoute><MyInvoicesPage /></ProtectedRoute>} />
        <Route path="/my/billing" element={<ProtectedRoute><MyInvoicesPage /></ProtectedRoute>} />
        <Route path="/my/cost-sheets" element={<ProtectedRoute><MyCostSheetsPage /></ProtectedRoute>} />
        <Route path="/home" element={<ProtectedRoute><ParentHomePage /></ProtectedRoute>} />
        <Route path="/provider/home" element={<ProtectedRoute><ProviderHomePage /></ProtectedRoute>} />
        <Route path="/admin/home" element={<ProtectedRoute><AdminHomePage /></ProtectedRoute>} />
        <Route path="/admin/agreements" element={<ProtectedRoute><AdminAgreementsPage /></ProtectedRoute>} />
        <Route path="/provider/billing" element={<ProtectedRoute><ProviderBillingPage /></ProtectedRoute>} />
        <Route path="/provider/invoices" element={<ProtectedRoute><ProviderBillingPage /></ProtectedRoute>} />
        <Route path="/provider/payouts" element={<ProtectedRoute><ProviderPayoutsPage /></ProtectedRoute>} />
        <Route path="/provider/cost-sheets" element={<ProtectedRoute><ProviderCostSheetsPage /></ProtectedRoute>} />
        <Route path="/provider/agreements" element={<ProtectedRoute><ProviderAgreementsPage /></ProtectedRoute>} />
        <Route path="/admin/concierge-monitor" element={<ProtectedRoute><AdminConciergeMonitor /></ProtectedRoute>} />
        <Route path="/admin/analytics" element={<ProtectedRoute><AdminAnalyticsPage /></ProtectedRoute>} />
        <Route path="/admin/reviews" element={<ProtectedRoute><AdminReviewsPage /></ProtectedRoute>} />
        <Route path="/admin/test-runner" element={<Navigate to="/account/test-runner" replace />} />
        <Route path="/provider/conversations" element={<Navigate to="/chat" replace />} />
        <Route path="/admin/branding" element={<Navigate to="/account/branding" replace />} />
        <Route path="/admin/security" element={<ProtectedRoute><AdminSecurityPage /></ProtectedRoute>} />
        <Route path="/account/*" element={<ProtectedRoute><AccountPage /></ProtectedRoute>} />
        <Route path="/book/:slug" element={<BookingPage />} />
        <Route path="/booking/:token/confirm" element={<BookingActionPage action="confirm" />} />
        <Route path="/booking/:token/decline" element={<BookingActionPage action="decline" />} />
        <Route path="/booking/:token/suggest-time" element={<BookingActionPage action="suggest-time" />} />
        <Route path="/booking/:token/manage" element={<BookingManagePage />} />
        <Route path="/video/:bookingId" element={<VideoRoomPage />} />
        <Route path="/room/:bookingId" element={<VideoRoomPage />} />
        <Route path="/recordings/:bookingId" element={<ProtectedRoute><RecordingPage /></ProtectedRoute>} />
        <Route path="/booking/:bookingId" element={<BookingConfirmationPage />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </LayoutShell>
  );
}

function App() {
  return (
    <ReduxProvider store={store}>
      <BrowserRouter>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <TooltipProvider>
              <ConfirmProvider>
                <ProfilePhotoTransitionProvider>
                  <VoiceSessionProvider>
                    <Toaster />
                    <AppRoutes />
                    <GlobalVoicePip />
                  </VoiceSessionProvider>
                </ProfilePhotoTransitionProvider>
              </ConfirmProvider>
            </TooltipProvider>
          </AuthProvider>
        </QueryClientProvider>
      </BrowserRouter>
    </ReduxProvider>
  );
}

export default App;
