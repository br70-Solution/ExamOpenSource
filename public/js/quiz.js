(() => {
  let session=null, questions=[], answers={}, correctCount=0, currentIdx=0, timerInt=null, endTime=null;
  const $=id=>document.getElementById(id);
  const DURATION_MS=60*60*1000;

  fetch('/api/config').then(r=>r.json()).then(c=>{
    $('q-count').textContent=c.totalQuestions;
    if($('total-q'))$('total-q').textContent=c.totalQuestions;
    if($('live-total'))$('live-total').textContent=c.totalQuestions;
    document.title=c.title;
  }).catch(()=>{});

  $('login-form').addEventListener('submit', async e=>{
    e.preventDefault();
    const name=$('fullName').value.trim(), group=$('groupNumber').value.trim();
    const al=$('login-alert'), btn=$('login-btn');
    btn.disabled=true; btn.textContent='CONNEXION...'; al.classList.remove('show');
    try{
      const res=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fullName:name,groupNumber:group})});
      const data=await res.json();
      if(res.status===409){
        // BLOQUÉ — L'étudiant a déjà passé l'examen
        al.innerHTML=`<div style="text-align:center;padding:10px 0">
          <div style="font-size:1.3rem;font-weight:800;color:var(--danger);margin-bottom:8px">⛔ ACCÈS REFUSÉ</div>
          <div style="margin-bottom:6px">${data.error}</div>
          ${data.score!==undefined?`<div style="font-size:1.1rem;font-weight:700;margin-top:8px">Votre note : <span style="color:var(--primary)">${data.score} / ${data.total}</span></div><div style="font-size:0.9rem;color:var(--text-muted);margin-top:4px">(${Math.round((data.score/data.total)*100)}%)</div>`:''}
        </div>`;
        al.classList.add('show');
        btn.disabled=true;
        btn.textContent='EXAMEN DÉJÀ PASSÉ';
        btn.style.opacity='0.5';
        btn.style.cursor='not-allowed';
        // Disable form inputs too
        $('fullName').disabled=true;
        $('groupNumber').disabled=true;
        return;
      }
      if(!res.ok){al.innerHTML=data.error;al.classList.add('show');btn.disabled=false;btn.textContent="COMMENCER L'EXAMEN";return;}
      session=data.session;
      $('student-name').textContent=`${name} (G: ${group})`;
      endTime=new Date(data.startTime).getTime()+DURATION_MS;
      if(Date.now()>=endTime){al.textContent='Temps écoulé.';al.classList.add('show');btn.disabled=false;btn.textContent="COMMENCER L'EXAMEN";return;}
      await loadQuestions();
    }catch(err){al.textContent='Erreur réseau';al.classList.add('show');btn.disabled=false;btn.textContent="COMMENCER L'EXAMEN";}
  });

  async function loadQuestions(){
    const res=await fetch('/api/questions',{headers:{'X-Session-Token':session}});
    const data=await res.json();
    questions=data.questions;
    if(data.savedAnswers){
      data.savedAnswers.forEach(a=>{answers[a.question_index]=a.selected_answer;});
    }
    $('total-q').textContent=questions.length;
    $('live-total').textContent=questions.length;
    showQ(0);
    startTimer();
    $('login-section').classList.add('hidden');
    $('quiz-section').classList.remove('hidden');
    fetchScore();
  }

  function showQ(i){
    if(i<0||i>=questions.length)return;
    currentIdx=i;
    const q=questions[i];
    $('q-id').textContent=`QUESTION ${i+1}`;
    $('q-cat').textContent=`• ${q.category||'LINUX'}`.toUpperCase();
    $('current-q').textContent=i+1;
    $('q-text').textContent=q.question;

    const locked=answers[i]!==undefined;
    $('q-options').innerHTML=q.options.map((o,j)=>{
      let cls='option-btn';
      if(locked && answers[i]===j) cls+=' selected';
      if(locked) cls+=' locked';
      return `<button class="${cls}" ${locked?'disabled':''} onclick="window._sel(${j})"><span class="option-letter">${'ABCD'[j]}</span><span>${o}</span></button>`;
    }).join('');
  }

  window._sel=async j=>{
    if(answers[currentIdx]!==undefined)return;
    answers[currentIdx]=j;
    try{
      await fetch('/api/answer',{method:'POST',headers:{'Content-Type':'application/json','X-Session-Token':session},body:JSON.stringify({questionIndex:currentIdx,selectedAnswer:j})});
      fetchScore();
    }catch(e){}
    showQ(currentIdx);
    if(currentIdx<questions.length-1){
      setTimeout(()=>showQ(currentIdx+1),800);
    } else {
      setTimeout(()=>submitExam(),1500);
    }
  };

  async function fetchScore(){
    try{
      const res=await fetch('/api/my-score',{headers:{'X-Session-Token':session}});
      const data=await res.json();
      correctCount=data.correct||0;
      $('live-score').textContent=correctCount;
      $('correct-count').textContent=correctCount;
    }catch(e){}
  }

  function startTimer(){updateTimer();timerInt=setInterval(updateTimer,1000);}
  function updateTimer(){
    const rem=Math.max(0,endTime-Date.now()),m=Math.floor(rem/60000),s=Math.floor((rem%60000)/1000);
    $('timer-display').textContent=`${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    const box=$('timer-box');box.classList.remove('warning','danger');
    if(m<5)box.classList.add('danger');else if(m<15)box.classList.add('warning');
    if(rem<=0){clearInterval(timerInt);submitExam();}
  }

  window.submitExam=async()=>{
    clearInterval(timerInt);
    try{
      const res=await fetch('/api/submit',{method:'POST',headers:{'Content-Type':'application/json','X-Session-Token':session},body:'{}'});
      const data=await res.json();
      $('quiz-section').classList.add('hidden');$('result-section').classList.remove('hidden');
      $('final-score').textContent=data.score;$('final-total').textContent=`/ ${data.totalQuestions}`;
      $('final-pct').textContent=`${data.percentage}%`;
      const circle=document.querySelector('.score-circle');
      if(data.percentage>=50){$('final-pct').style.color='var(--success)';$('final-msg').textContent='🎉 Félicitations, vous avez réussi !';circle.style.borderColor='var(--success)';}
      else{$('final-pct').style.color='var(--danger)';$('final-msg').textContent='Résultat insuffisant.';circle.style.borderColor='var(--danger)';}
    }catch(e){alert('Erreur soumission');}
  };
})();
