// Configuração do Firebase no formato Compat / CDN
const firebaseConfig = {
  apiKey: "AIzaSyAlIv1ImVhqwhItMNSAKirna__IH0OLgVg",
  authDomain: "saas-lead-scraper.firebaseapp.com",
  databaseURL: "https://saas-lead-scraper-default-rtdb.firebaseio.com",
  projectId: "saas-lead-scraper",
  storageBucket: "saas-lead-scraper.firebasestorage.app",
  messagingSenderId: "506880974012",
  appId: "1:506880974012:web:4d4bbdb726ff828da044b9"
};

// Inicialização Global
if (typeof firebase !== 'undefined' && !firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}