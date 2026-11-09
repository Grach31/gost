/* =========================================================
   Общая база для всех устройств (Firebase: вход + Firestore).
   Включается, только если в firebase-config.js задан конфиг.
   Каждая бронь — отдельный документ, поэтому правки с разных
   устройств не затирают друг друга. Изменения приходят сразу.
   ========================================================= */
const cfg = window.FIREBASE_CONFIG;
if (cfg) start().catch(err => {
  console.error(err);
  setStatus('off', 'Нет связи с базой');
});

function setStatus(kind, text){
  const el = document.getElementById('syncStatus');
  el.hidden = false;
  el.className = 'sync ' + kind;
  el.textContent = text;
}

async function start(){
  const V = '10.12.2';
  const [{ initializeApp }, A, F] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`)
  ]);

  const app  = initializeApp(cfg);
  const auth = A.getAuth(app);
  const db   = F.initializeFirestore(app, {
    localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() })
  });
  const bookingsCol = F.collection(db, 'bookings');
  const roomsDoc    = F.doc(db, 'meta', 'rooms');

  /* Брони, которые были на этом устройстве до подключения базы — предложим перенести */
  const localBefore = structuredClone(state);

  const loginBackdrop = document.getElementById('loginBackdrop');
  const loginError    = document.getElementById('loginError');
  const logoutBtn     = document.getElementById('logoutBtn');

  const fail = err => {
    console.error(err);
    alert('Не удалось сохранить в общую базу: ' + (err.code || err.message));
  };

  /* Запись в базу вместо браузера. Экран обновится сам, когда база пришлёт изменения. */
  Object.assign(store, {
    cloud: true,
    upsert(b){
      const { id, ...data } = b;
      F.setDoc(F.doc(bookingsCol, id), data).catch(fail);
    },
    remove(id){
      F.deleteDoc(F.doc(bookingsCol, id)).catch(fail);
    },
    async setRooms(rooms, prices = state.prices, categories = categoriesOf(state)){
      const settings = structuredClone({ rooms, prices: normalizePrices(prices, categories), categories });
      const nums = settings.rooms.map(r => r.num);
      const batch = F.writeBatch(db);
      batch.set(roomsDoc, settings);
      state.bookings.filter(b => !nums.includes(b.room)).forEach(b => batch.delete(F.doc(bookingsCol, b.id)));
      setStatus('pending', 'Сохраняются настройки…');
      try {
        await batch.commit();
        state.rooms = settings.rooms;
        state.categories = settings.categories;
        state.prices = settings.prices;
        state.bookings = state.bookings.filter(b => nums.includes(b.room));
        saveState();
        renderAll();
        setStatus('online', 'Общая база ✓');
      } catch (err) {
        setStatus('off', 'Настройки не сохранены');
        throw err;
      }
    },
    replaceAll(s){
      /* лимит пачки Firestore — 500 операций, режем на части */
      const ops = [];
      state.bookings.forEach(b => ops.push(batch => batch.delete(F.doc(bookingsCol, b.id))));
      s.bookings.forEach(b => { const { id, ...data } = b; ops.push(batch => batch.set(F.doc(bookingsCol, id), data)); });
      ops.push(batch => batch.set(roomsDoc, { rooms: s.rooms, prices: normalizePrices(s.prices, categoriesOf(s)), categories: categoriesOf(s) }));
      for (let i = 0; i < ops.length; i += 450){
        const batch = F.writeBatch(db);
        ops.slice(i, i + 450).forEach(op => op(batch));
        batch.commit().catch(fail);
      }
    }
  });

  document.getElementById('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    loginError.textContent = '';
    const btn = document.getElementById('loginBtn');
    btn.disabled = true;
    try {
      await A.signInWithEmailAndPassword(auth,
        document.getElementById('loginEmail').value.trim(),
        document.getElementById('loginPass').value);
    } catch (err){
      loginError.textContent = ['auth/invalid-credential','auth/wrong-password','auth/user-not-found','auth/invalid-email']
        .includes(err.code) ? 'Неверная почта или пароль' : 'Ошибка входа: ' + err.code;
    }
    btn.disabled = false;
  });

  logoutBtn.onclick = () => {
    if (confirm('Выйти из общей базы на этом устройстве?')) A.signOut(auth);
  };

  let unsubs = [];
  A.onAuthStateChanged(auth, user => {
    unsubs.forEach(u => u()); unsubs = [];

    if (!user){
      logoutBtn.hidden = true;
      loginBackdrop.classList.add('open');
      setStatus('off', 'Не выполнен вход');
      state = { rooms: structuredClone(DEFAULT_STATE.rooms), bookings: [], prices: {} };
      renderAll();
      return;
    }

    loginBackdrop.classList.remove('open');
    logoutBtn.hidden = false;
    setStatus('pending', 'Подключение…');
    state = { rooms: structuredClone(DEFAULT_STATE.rooms), bookings: [], prices: {} };
    renderAll();

    unsubs.push(F.onSnapshot(roomsDoc, snap => {
      const rooms = snap.exists() ? snap.data().rooms : null;
      if (rooms && validState({ ...snap.data(), rooms, bookings: [] })){
        state.rooms = rooms;
        state.categories = structuredClone(categoriesOf(snap.data()));
        state.prices = normalizePrices(snap.data().prices, state.categories);
        saveState(); renderAll();
      }
    }, err => setStatus('off', 'Нет доступа: ' + err.code)));

    let checkedMigration = false;
    unsubs.push(F.onSnapshot(bookingsCol, { includeMetadataChanges: true }, snap => {
      state.bookings = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderAll();
      if (snap.metadata.hasPendingWrites)  setStatus('pending', 'Сохраняется…');
      else if (snap.metadata.fromCache)    setStatus('pending', 'Нет сети — изменения отправятся позже');
      else                                 setStatus('online', 'Общая база ✓');

      if (!checkedMigration && !snap.metadata.fromCache){
        checkedMigration = true;
        const asked = localStorage.getItem('gost-cloud-migrated');
        localStorage.setItem('gost-cloud-migrated', '1');   // спрашиваем только один раз на устройстве
        if (!asked && snap.empty && localBefore.bookings.length &&
            confirm(`В общей базе пока нет броней. Перенести ${localBefore.bookings.length} брон. с этого устройства?`)){
          store.replaceAll(localBefore);
        }
      }
    }, err => setStatus('off', 'Нет доступа: ' + err.code)));
  });
}
