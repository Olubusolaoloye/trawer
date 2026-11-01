import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from 'react-native';

export const colors = { brand: '#0F766E', ink: '#1C1917', muted: '#57534E', line: '#D6D3D1', bg: '#FAFAF9', danger: '#B91C1C', warn: '#B45309', good: '#047857' };

export function Button({ title, onPress, variant = 'primary', disabled, pending, style }: {
  title: string; onPress: () => void; variant?: 'primary' | 'secondary' | 'danger'; disabled?: boolean; pending?: boolean; style?: ViewStyle;
}) {
  const bg = variant === 'primary' ? colors.brand : variant === 'danger' ? colors.danger : '#fff';
  const fg = variant === 'secondary' ? colors.ink : '#fff';
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: disabled || pending }} disabled={disabled || pending} onPress={onPress}
      style={({ pressed }) => [s.button, { backgroundColor: bg, opacity: disabled ? 0.5 : pressed ? 0.85 : 1, borderWidth: variant === 'secondary' ? 2 : 0 }, style]}>
      {pending ? <ActivityIndicator color={fg} /> : <Text style={[s.buttonText, { color: fg }]}>{title}</Text>}
    </Pressable>
  );
}

export function Field({ label, ...rest }: TextInputProps & { label: string }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput accessibilityLabel={label} placeholderTextColor={colors.muted} style={s.input} {...rest} />
    </View>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[s.card, style]}>{children}</View>;
}

export function ErrorText({ error }: { error: string | null | undefined }) {
  return error ? <Text accessibilityRole="alert" style={{ color: colors.danger, fontWeight: '600' }}>{error}</Text> : null;
}

export const s = StyleSheet.create({
  button: { minHeight: 56, borderRadius: 14, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center', borderColor: colors.line },
  buttonText: { fontSize: 18, fontWeight: '700' },
  label: { fontSize: 15, fontWeight: '700', color: colors.ink },
  input: { minHeight: 52, borderWidth: 2, borderColor: colors.line, borderRadius: 14, paddingHorizontal: 14, fontSize: 18, backgroundColor: '#fff', color: colors.ink },
  card: { backgroundColor: '#fff', borderRadius: 16, borderWidth: 1, borderColor: colors.line, padding: 14 },
  h1: { fontSize: 24, fontWeight: '800', color: colors.ink },
  muted: { color: colors.muted, fontSize: 15 },
});
