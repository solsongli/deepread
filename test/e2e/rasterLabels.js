/* A bitmap-only plot, constructed locally. Run in the isolated Zotero harness.
 * The real OCR worker, page and book cache, PDF exporter and graphic pixels
 * are exercised. Only the translation provider is replaced for this fixture. */
E2E.run = async function () {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let i = 0; i < 200 && !Zotero.DeepRead?.Panes?.paneIDs?.chat; i++) await wait(60);
  const D = Zotero.DeepRead,
    win = Zotero.getMainWindow(),
    doc = win.document;
  const check = (name, ok) => {
    E2E.result.steps.push({ name, ok: !!ok });
    if (!ok) throw new Error(name);
  };
  const canvas = doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = 900;
  canvas.height = 500;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 900, 500);
  ctx.fillStyle = "#151515";
  ctx.font = "23px sans-serif";
  ctx.fillText("Example measurements", 180, 40);
  ctx.strokeRect(55, 70, 530, 350);
  for (let n = 0; n < 38; n++) {
    ctx.fillStyle = n % 2 ? "#b72851" : "#1665a5";
    ctx.fillRect(100 + ((n * 47) % 420), 100 + ((n * 79) % 260), 9, 9);
  }
  const words = ["Control", "Treatment", "Baseline"];
  words.forEach((text, i) => {
    if (text === "Treatment") {
      ctx.fillStyle = "#f1dbb8";
      ctx.fillRect(648, 108 + i * 90, 190, 44);
    }
    ctx.fillStyle = ["#b72851", "#1665a5", "#f8ce48"][i];
    ctx.fillRect(620, 120 + i * 90, 18, 18);
    ctx.fillStyle = "#101010";
    ctx.fillText(text, 655, 137 + i * 90);
  });
  ctx.font="19px sans-serif";ctx.textAlign="center";ctx.lineWidth=3;
  for (const [top,fill,lines] of [[337,"#c2e8f7",["Feed","Forward"]],[411,"#f2f4c1",["Add & Norm"]]]) {
    ctx.fillStyle=fill;ctx.fillRect(625,top,205,58);
    ctx.strokeStyle="#151515";ctx.strokeRect(625,top,205,58);
    ctx.fillStyle="#101010";
    lines.forEach((line,i)=>ctx.fillText(line,727,top+(lines.length===1?35:24+i*23)));
  }
  const pdf = await D.ParallelPDF.create(),
    source = pdf.addPage();
  source.setSize(520, 500);
  const figure = await pdf.embedPng(canvas.toDataURL("image/png"));
  source.drawImage(figure, { x: 56, y: 120, width: 400, height: 222.2 });
  const names = ["Grasp","Slide","Insert"];
  canvas.width = 148;
  canvas.height = 96;
  for (const [i,fill] of ["#526b8c","#776745","#49745b"].entries()) {
    ctx.fillStyle=fill;
    ctx.fillRect(0,0,148,96);
    ctx.fillStyle="#d2b78f";
    ctx.fillRect(18+i*9,32,70,40);
    const thumbnail = await pdf.embedPng(canvas.toDataURL("image/png"));
    source.drawImage(thumbnail,{ x:50+i*84,y:364,width:74,height:48 });
  }
  // The captions are separate image ink below the panels. They are outside
  // all three image boxes and have no PDF text layer.
  canvas.width = 484;
  canvas.height = 30;
  ctx.fillStyle="#fff";
  ctx.fillRect(0,0,484,30);
  ctx.fillStyle="#161616";
  ctx.font="bold 16px sans-serif";
  ctx.textAlign="center";
  names.forEach((name,i)=>ctx.fillText(name,74+i*168,20));
  const captionInk=await pdf.embedPng(canvas.toDataURL("image/png"));
  source.drawImage(captionInk,{ x:50,y:348,width:242,height:15 });
  const path = PathUtils.join(E2E.env("DEEPREAD_E2E_SHOTS"), "source-chart.pdf");
  await IOUtils.write(path, Uint8Array.from(await pdf.save()));
  const item = await Zotero.Attachments.importFromFile({
    file: Zotero.File.pathToFile(path),
    libraryID: Zotero.Libraries.userLibraryID
  });
  D.prefs.set("parser.provider", "builtin");
  D.prefs.set("cards.autoExplain", false);
  const reader = await Zotero.Reader.open(item.id);
  await reader._initPromise;
  const session = D.Session.forReader(reader);
  await session.init();
  const control = (session.comparison = new D.ParallelReader(session));
  const original = D.LLM.complete;
  const labels = new Map([
    ["Control", "对照"],
    ["Treatment", "处理"],
    ["Baseline", "基线"],
    ["Feed Forward","前馈网络"],
    ["Add & Norm","相加并归一化"],
    ["Grasp","抓取"],
    ["Slide","滑动"],
    ["Insert","插入"],
    ["Example measurements", "测量示例"]
  ]);
  let calls = 0;
  try {
    D.LLM.complete = async (args) => {
      const rows = JSON.parse(args.messages[0].content.split("\n").slice(1).join("\n"));
      calls++;
      return {
        content: JSON.stringify({
          translations: rows.map((row) => ({
            id: row.id,
            translation: labels.get(row.source_text) || row.source_text
          }))
        })
      };
    };
    await control.open(session.overlay.readerDoc.querySelector(".dr-parallel-button"));
    check(
      "opening discovers embedded artwork without recognition or model work",
      calls === 0 && !control.page.rasterLabels.length &&
        control.page.imageCandidates.some(candidate=>candidate.panels?.length===3)
    );
    await control.translateBook();
    const page = control.page,
      translated = control.target.stage;
    check(
      "book translation recognises the three real English legend labels",
      words.every((w) => page.rasterLabels.some((l) => l.text === w))
    );
    check("outlined diagram nodes keep complete multi-line names",["Feed Forward","Add & Norm"]
      .every(name=>page.rasterLabels.some(l=>l.text===name) && translated.textContent.includes(labels.get(name))));
    check("captions printed below the three pictures are found and translated",names.every(name=>
      page.rasterLabels.some(label=>label.panelCaption && label.text===name) &&
      translated.textContent.includes(labels.get(name))));
    check(
      "labels occupy the page and do not spill into supplements",
      words.every((w) => translated.textContent.includes(labels.get(w))) && !page.supplements.length
    );
    const src = control.source.canvas.getContext("2d").getImageData(210, 455, 270, 140).data;
    const dst = control.target.canvas.getContext("2d").getImageData(210, 455, 270, 140).data;
    check(
      "the data points remain pixel-identical",
      src.some((v, i) => i % 4 === 0 && v < 190) && dst.every((v, i) => i%4!==3 || v===0)
    );
    const previous = calls;
    control.close(false);
    await control.open(session.overlay.readerDoc.querySelector(".dr-parallel-button"));
    check(
      "cached recognised geometry and text reopen without another request",
      calls === previous &&
        control.page.imageCandidates.length === 0 &&
        control.target.stage.textContent.includes("对照")
    );
    const output = PathUtils.join(E2E.env("DEEPREAD_E2E_SHOTS"), "chart-zh.pdf");
    check("labelled chart exports normally", await control.savePDF("page", output));
    const attached = await Zotero.Attachments.importFromFile({
      file: Zotero.File.pathToFile(output),
      libraryID: Zotero.Libraries.userLibraryID
    });
    const extracted = (await Zotero.PDFWorker.getFullText(attached.id)).text.replace(/\s+/g, "");
    check(
      "the saved PDF contains selectable translated labels",
      ["对照", "处理", "基线"].every((s) => extracted.includes(s))
    );
  } finally {
    D.LLM.complete = original;
    control.close(false);
  }
  await wait(300);
  return { checks: E2E.result.steps.length };
};
