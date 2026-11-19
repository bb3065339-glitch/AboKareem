# أبو كريم الحاتي — مشروع المطعم

موقع ثابت (HTML/CSS/JS) + Firebase Auth + Firestore. جاهز للرفع على Vercel بدون أي build.

## الهيكل
- `index.html` — كل شيء داخله (CSS وJavaScript وبيانات المنيو وإعدادات Firebase)
- `firestore.rules` — قواعد الأمان · `vercel.json` · `firebase.json`

## النشر على Vercel
1. ارفع المجلد (Import من GitHub أو `vercel --prod`) — Framework: Other، بدون Build Command.
2. **ضروري لـ Google:** Firebase Console ← Authentication ← Settings ← Authorized domains ← أضف نطاق Vercel (مثل `your-app.vercel.app`) ونطاقك المخصص إن وُجد.
3. Authentication ← Sign-in method ← فعّل **Google** وحدّد بريد الدعم.
4. انشر القواعد: `firebase deploy --only firestore:rules` (أو الصقها في Firestore ← Rules).

## ملاحظات Google على الجوال
`signInWithRedirect` قد يفشل في Safari/المتصفحات الحديثة بسبب تقسيم التخزين بين النطاقات.
إن ظهر ذلك: غيّر `authDomain` داخل `index.html` (ابحث عن `const CFG`) إلى نطاق موقعك على Vercel (بدون https)،
ثم أضف `https://نطاقك/__/auth/handler` إلى Authorized redirect URIs في OAuth Client بـ Google Cloud Console.
ملف `vercel.json` يحوي بالفعل إعادة التوجيه `/__/auth/*` اللازمة.

## الأمان
قيم `apiKey` في إعدادات الويب عامة وليست سرًا؛ الحماية تأتي من القواعد ومن Authorized domains.
لا تضع Service Account أو أي مفتاح خاص في هذا المجلد.
