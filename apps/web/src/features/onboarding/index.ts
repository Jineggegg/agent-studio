import { Sparkles } from 'lucide-react';
import { registerFeatureRoutes, registerSettingsPage } from '@/registry';

/**
 * The welcome guide after the first sign-in: commit identity, agent
 * accounts, a first project, notifications on this device (the owner); the
 * lighter guide for a member (identity, notifications). The launcher offers
 * it with a card (`WelcomeCard`) to a new account; Settings → Getting
 * started opens it again. Registration only.
 */
registerFeatureRoutes({ path: 'welcome', name: 'onboarding.title', load: () => import('./WelcomeScreen') });

registerSettingsPage({ id: 'getting-started', title: 'onboarding.settings.title', icon: Sparkles, tint: 'amber', group: 'general', order: 95, load: () => import('./GettingStartedPage') });
