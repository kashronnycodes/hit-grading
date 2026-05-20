import { Image, Info } from 'lucide-react';

export function FileUpload({ id, label, file, preview, onChange }) {
  return (
    <section className="upload-field">
      <div className="field-heading">
        <div className="field-icon" aria-hidden="true">
          <Image size={25} />
        </div>
        <h2>{label} <span>*</span></h2>
      </div>

      <label className={`drop-zone ${preview ? 'has-preview' : ''}`} htmlFor={id}>
        {preview ? (
          <>
            <img src={preview} alt={`${label} preview`} />
            {id === 'front-upload' ? <span className="card-guide-border" aria-hidden="true" /> : null}
          </>
        ) : (
          <>
            <span className="drop-icon"><Image size={25} /></span>
            <span>Tap to upload image</span>
            {id === 'front-upload' ? <span className="card-guide-border empty-guide" aria-hidden="true" /> : null}
          </>
        )}
      </label>

      <div className="file-row">
        <label className="file-button" htmlFor={id}>
          Choose File
          <input
            id={id}
            type="file"
            accept="image/jpeg,image/png,image/heic,image/heif,.jpg,.jpeg,.png,.heic,.heif"
            onChange={(event) => onChange(event.target.files?.[0] || null)}
          />
        </label>
        <p className="file-name">{file?.name || 'No file chosen'}</p>
      </div>

      <p className="support-text"><Info size={14} /> Supported formats: JPG, PNG, or HEIC</p>

      {id === 'front-upload' ? (
        <ul className="photo-tips">
          <li>Place the whole card inside the border.</li>
          <li>Use bright, even lighting and avoid glare.</li>
          <li>Keep the camera straight above the card.</li>
          <li>Make the card name and bottom number readable.</li>
          <li>Use a dark or plain background if possible.</li>
        </ul>
      ) : null}

      {!preview && file ? <p className="heic-note">{file.name}</p> : null}
    </section>
  );
}
