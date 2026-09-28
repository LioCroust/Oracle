import { Tabs } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { useOracleReset } from '@/contexts/OracleResetContext';

export default function TabLayout() {
  const colors = useColors();
  const { triggerReset } = useOracleReset();
  const insets = useSafeAreaInsets();
  const tabBarContentHeight = 46;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: 'rgba(10, 8, 21, 0.95)',
          borderTopColor: 'rgba(201, 168, 76, 0.25)',
          borderTopWidth: 1,
          height: tabBarContentHeight + insets.bottom,
          paddingTop: 0,
          paddingBottom: insets.bottom,
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 10,
        },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.mutedForeground,
        tabBarLabelStyle: {
          fontFamily: 'Inter_600SemiBold',
          fontSize: 11,
          marginTop: -4,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Oracle',
          tabBarIcon: ({ color, size }) => (
            <Feather name="aperture" size={size} color={color} />
          ),
        }}
        listeners={{
          tabPress: (e) => {
            triggerReset();
          },
        }}
      />
      <Tabs.Screen
        name="boutique"
        options={{
          title: 'Boutique',
          tabBarIcon: ({ color, size }) => (
            <Feather name="shopping-bag" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Options',
          tabBarIcon: ({ color, size }) => (
            <Feather name="settings" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
