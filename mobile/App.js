import React, { useEffect, useState } from 'react';
import { ActivityIndicator, AppState, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';

const base = process.env.EXPO_PUBLIC_API_URL;
const statusText = { active: 'ใช้งานอยู่', suspended: 'ถูกระงับ', expired: 'หมดอายุ' };
const storage = {
  get: () => Platform.OS === 'web' ? Promise.resolve(null) : SecureStore.getItemAsync('gym.session'),
  set: value => Platform.OS === 'web' ? Promise.resolve() : value ? SecureStore.setItemAsync('gym.session', value) : SecureStore.deleteItemAsync('gym.session'),
};
function Button({ children, onPress, disabled, secondary = false }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} onPress={onPress} disabled={disabled}
    style={({ pressed }) => [s.button, secondary && s.secondary, (disabled || pressed) && { opacity: .55 }]}><Text style={[s.buttonText, secondary && { color: '#175C50' }]}>{children}</Text></Pressable>;
}
function Input({ label, ...props }) { return <View style={s.field}><Text style={s.label}>{label}</Text><TextInput accessibilityLabel={label} placeholderTextColor="#52616B" style={s.input} {...props}/></View>; }
function AppContent() {
  const [token, setToken] = useState(null), [user, setUser] = useState(null), [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [email, setEmail] = useState('');
  const [challenge, setChallenge] = useState(null), [code, setCode] = useState(''), [remaining, setRemaining] = useState(0);
  const [name, setName] = useState(''), [phone, setPhone] = useState('');
  async function request(path, method = 'GET', body, session = token) {
    if (!base || (!__DEV__ && !base.startsWith('https://'))) throw new Error('กรุณาตั้งค่าที่อยู่ระบบให้ถูกต้องก่อนใช้งาน');
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`${base}/api${path}`, { method, signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-Gym-Client': 'mobile', ...(session && { Authorization: `Bearer ${session}` }) },
        ...(body && { body: JSON.stringify(body) }) });
      const data = response.status === 204 ? null : await response.json();
      if (!response.ok) {
        if (response.status === 401) { await storage.set(null); setToken(null); setUser(null); setChallenge(null); }
        throw new Error(data.fields ? Object.values(data.fields).join('\n') : data.error);
      }
      return data;
    } catch(e) { if (e.name === 'AbortError' || e.message === 'Network request failed') throw new Error('เชื่อมต่อไม่ได้ กรุณาตรวจอินเทอร์เน็ตแล้วลองใหม่'); throw e; }
    finally { clearTimeout(timeout); }
  }
  async function run(fn) { setBusy(true); setError(''); try { await fn(); } catch(e) { setError(e.message); } finally { setBusy(false); } }
  useEffect(() => { (async () => { try { const saved = await storage.get(); if (saved) { setToken(saved); setUser(await request('/me', 'GET', null, saved)); } } catch(e) { setError(e.message); } finally { setLoading(false); } })(); }, []);
  useEffect(() => { if (!remaining) return; const timer = setTimeout(() => setRemaining(remaining - 1), 1000); return () => clearTimeout(timer); }, [remaining]);
  useEffect(() => {
    const listener = AppState.addEventListener('change', state => { if (state === 'active' && token) run(async () => setUser(await request('/me'))); });
    return () => listener.remove();
  }, [token]);
  async function sendCode() { setChallenge(await request('/auth/request-otp', 'POST', { email: email.trim() })); setCode(''); setRemaining(60); }
  if (loading) return <SafeAreaView style={s.safe}><ActivityIndicator size="large" color="#175C50" accessibilityLabel="กำลังโหลด"/></SafeAreaView>;
  return <SafeAreaView style={s.safe}><KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <ScrollView contentContainerStyle={s.container} keyboardShouldPersistTaps="handled">
      <View style={s.header}><Text style={s.brand}>G · ยิมของเรา</Text>{user && <Button secondary disabled={busy} onPress={() => run(async () => { await request('/auth/logout', 'POST'); await storage.set(null); setToken(null); setUser(null); setChallenge(null); setCode(''); })}>ออกจากระบบ</Button>}</View>
      {!!error && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}
      {!user ? <View style={s.panel}><Text style={s.title}>{challenge ? 'ยืนยันอีเมล' : 'ยินดีต้อนรับ'}</Text><Text style={s.muted}>{challenge ? `กรอกรหัส 6 หลักที่ส่งไปยัง ${email} ภายใน 5 นาที` : 'เข้าสู่ระบบหรือสมัครสมาชิก\nด้วยอีเมล ไม่ต้องจำรหัสผ่าน'}</Text>
        {!challenge ? <><Input label="อีเมล" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoComplete="email" textContentType="emailAddress"/>
          <Button disabled={busy || !email.trim()} onPress={() => run(sendCode)}>{busy ? 'กำลังส่ง…' : 'รับรหัสทางอีเมล'}</Button></> : <>
          <Input label="รหัสยืนยัน 6 หลัก" value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6} autoComplete="one-time-code" textContentType="oneTimeCode"/>
          <Button disabled={busy || !/^\d{6}$/.test(code)} onPress={() => run(async () => { const result = await request('/auth/verify-otp', 'POST', { challenge_id: challenge.challenge_id, code }); await storage.set(result.token); setToken(result.token); setUser(result); setCode(''); })}>{busy ? 'กำลังยืนยัน…' : 'ยืนยันและเข้าสู่ระบบ'}</Button>
          <Button secondary disabled={busy || remaining > 0} onPress={() => run(sendCode)}>{remaining ? `ส่งใหม่ได้ใน ${remaining} วินาที` : 'ส่งรหัสใหม่'}</Button>
          <Button secondary disabled={busy} onPress={() => { setChallenge(null); setError(''); }}>เปลี่ยนอีเมล</Button></>}
      </View> : user.role !== 'member' ? <View style={s.panel}><Text style={s.title}>บัญชีพนักงาน</Text><Text style={s.muted}>กรุณาใช้เว็บแอดมินสำหรับจัดการสมาชิก</Text></View>
        : !user.member ? <View style={s.panel}><Text style={s.title}>ทำความรู้จักกัน</Text><Text style={s.muted}>กรอกชื่อและเบอร์มือถือเพื่อสร้างบัตรสมาชิก</Text>
          <Input label="ชื่อ–นามสกุล" value={name} onChangeText={setName} maxLength={120} autoComplete="name"/>
          <Input label="เบอร์มือถือ" value={phone} onChangeText={setPhone} keyboardType="phone-pad" autoComplete="tel"/>
          <Button disabled={busy || !name.trim() || !phone.trim()} onPress={() => run(async () => { await request('/me/profile', 'PUT', { name, phone }); setUser(await request('/me')); })}>{busy ? 'กำลังบันทึก…' : 'เริ่มใช้งาน'}</Button>
        </View> : <><View style={s.memberCard}><Text style={s.eyebrow}>บัตรสมาชิกของคุณ</Text><Text style={s.memberName}>{user.member.name}</Text><Text style={s.memberCode}>{user.member.member_code}</Text>
          <Text style={s.badge}>{statusText[user.member.status]}</Text><Text style={s.joined}>เป็นสมาชิกตั้งแต่ {new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeZone: 'Asia/Bangkok' }).format(new Date(user.member.joined_at))}</Text></View>
          <View style={s.panel}><Text style={s.heading}>ข้อมูลของฉัน</Text><Text style={s.label}>อีเมล</Text><Text style={s.value}>{user.member.email}</Text><Text style={s.label}>เบอร์มือถือ</Text><Text style={s.value}>{user.member.phone}</Text>
            {user.member.status !== 'active' && <Text style={s.error}>{user.member.status === 'suspended' ? 'บัญชีสมาชิกถูกระงับ' : 'สถานะสมาชิกหมดอายุ'} กรุณาติดต่อพนักงานที่ยิม</Text>}
            <Text style={s.muted}>หากต้องการแก้ไขข้อมูล กรุณาติดต่อพนักงาน</Text><Button secondary disabled={busy} onPress={() => run(async () => setUser(await request('/me')))}>{busy ? 'กำลังโหลด…' : 'รีเฟรชข้อมูล'}</Button>
          </View></>}
      <Text style={s.footer}>ทุกวันเป็นวันเริ่มต้นที่ดี</Text>
    </ScrollView></KeyboardAvoidingView></SafeAreaView>;
}
export default function App() { return <SafeAreaProvider><AppContent/></SafeAreaProvider>; }
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F3F6F5' }, container: { padding: 20, maxWidth: 600, width: '100%', alignSelf: 'center', flexGrow: 1 },
  header: { gap: 12, marginBottom: 30 }, brand: { fontSize: 23, fontWeight: '700', color: '#175C50' },
  panel: { backgroundColor: 'white', padding: 24, borderRadius: 18, borderWidth: 1, borderColor: '#CCD5D8', marginBottom: 20 },
  title: { fontSize: 28, fontWeight: '700', color: '#172B36', marginBottom: 14 }, heading: { fontSize: 22, fontWeight: '600', color: '#172B36', marginBottom: 20 },
  muted: { color: '#52616B', fontSize: 16, lineHeight: 26, marginBottom: 20 }, field: { marginBottom: 20 },
  label: { color: '#52616B', fontSize: 14, marginBottom: 8 }, input: { borderWidth: 1, borderColor: '#71838C', borderRadius: 10, padding: 14, minHeight: 50, fontSize: 16, color: '#172B36' },
  button: { minHeight: 48, borderRadius: 10, backgroundColor: '#175C50', justifyContent: 'center', alignItems: 'center', padding: 14, marginBottom: 10 },
  buttonText: { color: 'white', fontSize: 16, fontWeight: '600', textAlign: 'center' }, secondary: { backgroundColor: '#E8F1EE', borderWidth: 1, borderColor: '#CCD5D8' },
  error: { color: '#9B2C22', backgroundColor: '#FBEDEB', padding: 14, borderRadius: 10, marginBottom: 20, fontSize: 15, lineHeight: 24 },
  memberCard: { backgroundColor: '#175C50', padding: 26, borderRadius: 20, marginBottom: 20 }, eyebrow: { color: '#BFDCD4', fontSize: 14, marginBottom: 28 },
  memberName: { color: 'white', fontSize: 28, fontWeight: '700', marginBottom: 8 }, memberCode: { color: '#BFDCD4', fontSize: 14, marginBottom: 22 },
  badge: { backgroundColor: '#E8F1EE', color: '#175C50', alignSelf: 'flex-start', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 6, overflow: 'hidden' },
  joined: { color: '#BFDCD4', fontSize: 13, marginTop: 30 }, value: { fontSize: 17, color: '#172B36', marginBottom: 22 }, footer: { color: '#52616B', fontSize: 13, textAlign: 'center', margin: 20 },
});
