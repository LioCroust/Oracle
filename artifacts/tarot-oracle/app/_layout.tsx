import React, { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setBaseUrl } from '@workspace/api-client-react';
import { Platform } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from '@expo-google-fonts/inter';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { NavigationBar } from 'expo-navigation-bar';
import * as SystemUI from 'expo-system-ui';
import colors from '@/constants/colors';
import { AdminAccessProvider } from '@/contexts/AdminAccessContext';
import { CreditsProvider } from '@/contexts/CreditsContext';
import { OracleResetProvider } from '@/contexts/OracleResetContext';
import { CreditCelebration } from '@/components/CreditCelebration';

// Set API base URL for all generated hooks
setBaseUrl(`https://${process.env.EXPO_PUBLIC_DOMAIN ?? ''}`);

if (Platform.OS === 'android') {
  SystemUI.setBackgroundColorAsync(colors.light.background).catch((error) => {
    console.warn('Could not set the Android system-bar background:', error);
  });
}

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient();

function RootLayoutNav() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {Platform.OS === 'android' ? <NavigationBar style="dark" /> : null}
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <GestureHandlerRootView
            style={{ flex: 1, backgroundColor: colors.light.background }}
          >
            <KeyboardProvider>
              <AdminAccessProvider>
                <CreditsProvider>
                  <OracleResetProvider>
                    <RootLayoutNav />
                  </OracleResetProvider>
                  <CreditCelebration />
                </CreditsProvider>
              </AdminAccessProvider>
            </KeyboardProvider>
          </GestureHandlerRootView>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
