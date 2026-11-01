import Constants from 'expo-constants';

export const API_URL: string = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ?? 'https://app.trawer.shop';
