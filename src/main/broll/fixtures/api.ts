/**
 * Recorded answers for the B-roll sources' tests, each in the shape its
 * API's published documentation gives, and for the APIs this machine can
 * reach, checked against a live answer. Every name in them is made up.
 *
 * Openverse: api.openverse.org/v1/ (Swagger), live-checked.
 * Wikimedia Commons: MediaWiki Action API, prop=imageinfo / videoinfo, formatversion=2, live-checked.
 * NASA: images.nasa.gov API documentation (search, asset, metadata), live-checked.
 * Internet Archive: advancedsearch.php (output=json) and the metadata API, live-checked.
 * Steam: the store's storesearch and appdetails, which are not formally documented; live-checked.
 * Bluesky: the app.bsky lexicons (searchPosts, searchActors, getAuthorFeed), live-checked.
 * Pexels, Pixabay, Unsplash, GIPHY, Freesound: their published API docs only (not reachable from here).
 * Claude web search: the web_search tool's documented response blocks.
 */

export const openverseImages = {
  result_count: 2,
  page_count: 1,
  page_size: 20,
  page: 1,
  results: [
    {
      id: '0b6f5d2e-1111-4c1a-9a41-000000000001',
      title: 'Laptop keyboard at night',
      indexed_on: '2024-01-02T03:04:05Z',
      foreign_landing_url: 'https://www.flickr.com/photos/example/1000000001',
      url: 'https://live.staticflickr.com/1/1000000001_abc_b.jpg',
      creator: 'Example Photographer',
      creator_url: 'https://www.flickr.com/photos/example',
      license: 'by',
      license_version: '2.0',
      license_url: 'https://creativecommons.org/licenses/by/2.0/',
      provider: 'flickr',
      source: 'flickr',
      category: null,
      filesize: null,
      filetype: null,
      tags: [{ name: 'keyboard', accuracy: null, unstable__provider: 'flickr' }, { name: 'laptop', accuracy: null, unstable__provider: 'flickr' }],
      attribution: '"Laptop keyboard at night" by Example Photographer is licensed under CC BY 2.0.',
      fields_matched: ['title', 'tags.name'],
      mature: false,
      height: 768,
      width: 1024,
      thumbnail: 'https://api.openverse.org/v1/images/0b6f5d2e-1111-4c1a-9a41-000000000001/thumb/',
      detail_url: 'https://api.openverse.org/v1/images/0b6f5d2e-1111-4c1a-9a41-000000000001/',
      related_url: 'https://api.openverse.org/v1/images/0b6f5d2e-1111-4c1a-9a41-000000000001/related/',
      unstable__sensitivity: []
    },
    {
      id: '0b6f5d2e-1111-4c1a-9a41-000000000002',
      title: 'Typing hands',
      foreign_landing_url: 'https://www.flickr.com/photos/example/1000000002',
      url: 'https://live.staticflickr.com/1/1000000002_abc_b.jpg',
      creator: 'Another Example',
      creator_url: null,
      license: 'by-nc-sa',
      license_version: '2.0',
      license_url: 'https://creativecommons.org/licenses/by-nc-sa/2.0/',
      provider: 'flickr',
      source: 'flickr',
      filesize: null,
      filetype: 'jpg',
      tags: [{ name: 'typing' }],
      mature: false,
      height: 1365,
      width: 2048,
      thumbnail: 'https://api.openverse.org/v1/images/0b6f5d2e-1111-4c1a-9a41-000000000002/thumb/'
    }
  ]
}

export const openverseAudio = {
  result_count: 1,
  page_count: 1,
  page_size: 20,
  page: 1,
  results: [
    {
      id: 'aa6f5d2e-2222-4c1a-9a41-000000000003',
      title: 'Soft whoosh',
      foreign_landing_url: 'https://freesound.org/people/example/sounds/1000003',
      url: 'https://cdn.freesound.org/previews/1/1000003_1-hq.mp3',
      creator: 'example',
      creator_url: 'https://freesound.org/people/example',
      license: 'cc0',
      license_version: '1.0',
      license_url: 'https://creativecommons.org/publicdomain/zero/1.0/',
      provider: 'freesound',
      source: 'freesound',
      category: null,
      genres: null,
      filesize: 69196,
      filetype: 'mp3',
      tags: [{ name: 'whoosh' }, { name: 'transition' }],
      duration: 1450,
      mature: false,
      thumbnail: null
    }
  ]
}

export const wikimediaImages = {
  batchcomplete: true,
  continue: { gsroffset: 2, continue: 'gsroffset||' },
  query: {
    pages: [
      {
        pageid: 50000001,
        ns: 6,
        title: 'File:Backlit keyboard example.jpg',
        index: 2,
        imagerepository: 'local',
        imageinfo: [
          {
            size: 2597184,
            width: 4357,
            height: 2451,
            thumburl: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/c/c4/Backlit_keyboard_example.jpg/960px-Backlit_keyboard_example.jpg',
            thumbwidth: 640,
            thumbheight: 360,
            url: 'https://upload.wikimedia.org/wikipedia/commons/c/c4/Backlit_keyboard_example.jpg',
            descriptionurl: 'https://commons.wikimedia.org/wiki/File:Backlit_keyboard_example.jpg',
            mime: 'image/jpeg',
            mediatype: 'BITMAP',
            extmetadata: {
              ObjectName: { value: 'Backlit keyboard example', source: 'mediawiki-metadata' },
              Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Example">Example</a>', source: 'commons-desc-page' },
              LicenseShortName: { value: 'CC BY-SA 4.0', source: 'commons-desc-page', hidden: '' },
              License: { value: 'cc-by-sa-4.0', source: 'commons-templates', hidden: '' },
              LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0', source: 'commons-desc-page' },
              AttributionRequired: { value: 'true', source: 'commons-desc-page', hidden: '' },
              Restrictions: { value: '', source: 'commons-desc-page', hidden: '' },
              Categories: { value: 'Computer keyboards|Backlit keyboards', source: 'commons-categories' }
            }
          }
        ]
      },
      {
        pageid: 50000002,
        ns: 6,
        title: 'File:Keyboard close up example.jpg',
        index: 1,
        imageinfo: [
          {
            size: 1200000,
            width: 3000,
            height: 2000,
            thumburl: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/a1/Keyboard_close_up_example.jpg/960px-Keyboard_close_up_example.jpg',
            url: 'https://upload.wikimedia.org/wikipedia/commons/a/a1/Keyboard_close_up_example.jpg',
            descriptionurl: 'https://commons.wikimedia.org/wiki/File:Keyboard_close_up_example.jpg',
            mime: 'image/jpeg',
            mediatype: 'BITMAP',
            extmetadata: {
              ObjectName: { value: 'Keyboard close up example' },
              Artist: { value: 'Example Contributor' },
              LicenseShortName: { value: 'CC BY 4.0' },
              License: { value: 'cc-by-4.0' },
              Restrictions: { value: 'trademarked' },
              ImageDescription: { value: 'A <b>keyboard</b>, close up.' }
            }
          }
        ]
      }
    ]
  }
}

export const wikimediaVideos = {
  batchcomplete: true,
  query: {
    pages: [
      {
        pageid: 50000003,
        ns: 6,
        title: 'File:Rocket launch example.webm',
        index: 1,
        videoinfo: [
          {
            size: 75592850,
            width: 1280,
            height: 720,
            duration: 269.887,
            url: 'https://upload.wikimedia.org/wikipedia/commons/0/01/Rocket_launch_example.webm',
            descriptionurl: 'https://commons.wikimedia.org/wiki/File:Rocket_launch_example.webm',
            mime: 'video/webm',
            mediatype: 'VIDEO',
            derivatives: [
              {
                src: 'https://upload.wikimedia.org/wikipedia/commons/transcoded/0/01/Rocket_launch_example.webm/Rocket_launch_example.webm.480p.vp9.webm',
                type: 'video/webm; codecs="vp9, opus"',
                transcodekey: '480p.vp9.webm',
                width: 854,
                height: 480
              }
            ],
            extmetadata: {
              ObjectName: { value: 'Rocket launch example' },
              Artist: { value: 'NASA/Example Center' },
              LicenseShortName: { value: 'Public domain' },
              License: { value: 'pd' },
              AttributionRequired: { value: 'false' },
              Categories: { value: 'Rocket launches|Sounding rockets' }
            }
          }
        ]
      }
    ]
  }
}

export const nasaSearch = {
  collection: {
    version: '1.0',
    href: 'http://images-api.nasa.gov/search?q=rocket%20launch',
    items: [
      {
        href: 'https://images-assets.nasa.gov/video/EXAMPLE-LAUNCH-1/collection.json',
        data: [
          {
            center: 'KSC',
            date_created: '2023-05-07T00:00:00Z',
            description: 'A rocket lifts off from the launch pad.',
            keywords: ['Rocket Launch', 'Rocket'],
            media_type: 'video',
            nasa_id: 'EXAMPLE-LAUNCH-1',
            title: 'Example rocket launch'
          }
        ],
        links: [
          { href: 'https://images-assets.nasa.gov/video/EXAMPLE-LAUNCH-1/EXAMPLE-LAUNCH-1~large.jpg', rel: 'alternate', render: 'image', width: 1920, height: 1080, size: 210000 },
          { href: 'https://images-assets.nasa.gov/video/EXAMPLE-LAUNCH-1/EXAMPLE-LAUNCH-1~thumb.jpg', rel: 'preview', render: 'image' }
        ]
      },
      {
        href: 'https://images-assets.nasa.gov/video/EXAMPLE-LAUNCH-2/collection.json',
        data: [
          {
            center: 'KSC',
            description: 'A launch filmed by the company that built the rocket.',
            keywords: ['Rocket Launch'],
            media_type: 'video',
            nasa_id: 'EXAMPLE-LAUNCH-2',
            photographer: 'Example Launch Company',
            title: 'Partner rocket launch'
          }
        ],
        links: [{ href: 'https://images-assets.nasa.gov/video/EXAMPLE-LAUNCH-2/EXAMPLE-LAUNCH-2~thumb.jpg', rel: 'preview', render: 'image' }]
      },
      {
        href: 'https://images-assets.nasa.gov/image/EXAMPLE-MOON-3/collection.json',
        data: [
          {
            center: 'GSFC',
            description: 'The Moon over the horizon. Image credit: NASA/Example Center',
            keywords: ['Moon'],
            media_type: 'image',
            nasa_id: 'EXAMPLE-MOON-3',
            title: 'Moonrise example'
          }
        ],
        links: [{ href: 'https://images-assets.nasa.gov/image/EXAMPLE-MOON-3/EXAMPLE-MOON-3~thumb.jpg', rel: 'preview', render: 'image' }]
      }
    ],
    metadata: { total_hits: 3 }
  }
}

/** The search's own asset link answers with a plain list; /asset/{id} with a collection. */
export const nasaAssets = (id: string, kind: 'image' | 'video'): { collection: { items: { href: string }[] } } => ({
  collection: {
    items:
      kind === 'video'
        ? [
            { href: `http://images-assets.nasa.gov/video/${id}/${id}~orig.mp4` },
            { href: `http://images-assets.nasa.gov/video/${id}/${id}~large.mp4` },
            { href: `http://images-assets.nasa.gov/video/${id}/${id}~medium.mp4` },
            { href: `http://images-assets.nasa.gov/video/${id}/${id}.vtt` },
            { href: `http://images-assets.nasa.gov/video/${id}/metadata.json` }
          ]
        : [
            { href: `http://images-assets.nasa.gov/image/${id}/${id}~orig.jpg` },
            { href: `http://images-assets.nasa.gov/image/${id}/${id}~large.jpg` },
            { href: `http://images-assets.nasa.gov/image/${id}/${id}~thumb.jpg` },
            { href: `http://images-assets.nasa.gov/image/${id}/metadata.json` }
          ]
  }
})

export const archiveSearch = {
  responseHeader: { status: 0, QTime: 68, params: { query: '(car) AND mediatype:movies', rows: 3, start: 0 } },
  response: {
    numFound: 3,
    start: 0,
    docs: [
      {
        identifier: 'ExampleFilm1952',
        title: 'Example Car Film',
        year: '1952',
        licenseurl: 'http://creativecommons.org/licenses/publicdomain/',
        collection: ['prelinger', 'fav-example'],
        subject: ['Automobiles; Driving']
      },
      { identifier: 'ExampleGovFilm', title: 'Example Road Safety', collection: ['FedFlix'], subject: 'road safety' },
      {
        identifier: 'uploader-claims-pd',
        title: 'A recording of a game',
        licenseurl: 'https://creativecommons.org/publicdomain/mark/1.0/',
        collection: ['opensource_movies']
      }
    ]
  }
}

export const archiveMetadata = {
  created: 1700000000,
  d1: 'ia800000.us.archive.org',
  dir: '/0/items/ExampleFilm1952',
  files: [
    { name: 'ExampleFilm1952.mpeg', source: 'original', format: 'MPEG2', size: '342735674', length: '742.2', width: '640', height: '480' },
    { name: 'ExampleFilm1952.mp4', source: 'derivative', format: 'h.264', size: '77321447', length: '742.24', width: '640', height: '480' },
    { name: 'ExampleFilm1952_512kb.mp4', source: 'derivative', format: '512Kb MPEG4', size: '52388249', length: '742.24', width: '320', height: '240' },
    { name: 'ExampleFilm1952.ogv', source: 'derivative', format: 'Ogg Video', size: '52871671', length: '742.24', width: '400', height: '304' }
  ],
  metadata: { identifier: 'ExampleFilm1952', title: 'Example Car Film', licenseurl: 'http://creativecommons.org/licenses/publicdomain/', collection: 'prelinger' }
}

export const steamSearch = {
  total: 2,
  items: [
    { type: 'app', name: 'Example Quest', id: 9000001, tiny_image: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/9000001/capsule_231x87.jpg', metascore: '' },
    { type: 'app', name: 'Example Quest Soundtrack', id: 9000002, tiny_image: '' }
  ]
}

export const steamApp = (hls: string): Record<string, unknown> => ({
  '9000001': {
    success: true,
    data: {
      type: 'game',
      name: 'Example Quest',
      steam_appid: 9000001,
      short_description: 'A space adventure.',
      developers: ['Example Studio'],
      publishers: ['Example Publishing'],
      header_image: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/9000001/0123456789abcdef0123456789abcdef01234567/header.jpg?t=1',
      genres: [{ id: '25', description: 'Adventure' }],
      content_descriptors: { ids: [2, 5], notes: 'Fantasy violence' },
      screenshots: [
        {
          id: 0,
          path_thumbnail: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/9000001/ss_aaaaaaaa.600x338.jpg?t=1',
          path_full: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/9000001/ss_aaaaaaaa.1920x1080.jpg?t=1'
        }
      ],
      movies: [
        {
          id: 7001,
          name: 'Launch Trailer',
          thumbnail: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/7001/movie.293x165.jpg',
          dash_h264: 'https://video.akamai.steamstatic.com/store_trailers/9000001/7001/x/dash_h264.mpd?t=1',
          hls_h264: hls,
          highlight: true
        },
        { id: 7002, name: 'Gameplay', thumbnail: '', dash_h264: 'https://video.akamai.steamstatic.com/store_trailers/9000001/7002/x/dash_h264.mpd', highlight: false }
      ]
    }
  }
})

/** A trailer's DASH manifest as Steam serves it beside the HLS (application/dash+xml), cut to what matters. */
export const steamMpd = `<?xml version='1.0' encoding='utf-8'?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-live:2011" type="static" mediaPresentationDuration="PT1M15.9S" maxSegmentDuration="PT3.0S" minBufferTime="PT6.0S">
	<Period id="0" start="PT0.0S">
		<AdaptationSet id="0" contentType="video" startWithSAP="1" segmentAlignment="true" bitstreamSwitching="true" frameRate="30000/1001" maxWidth="1920" maxHeight="1080" par="16:9">
			<Representation id="0" mimeType="video/mp4" codecs="avc1.640029" bandwidth="5000000" width="1920" height="1080" sar="1:1">
				<SegmentTemplate timescale="1000000" duration="3000000" initialization="dash_h264/init-stream$RepresentationID$.m4s" media="dash_h264/chunk-stream$RepresentationID$-$Number%05d$.m4s" startNumber="1" />
			</Representation>
			<Representation id="1" mimeType="video/mp4" codecs="avc1.640029" bandwidth="1400000" width="854" height="480" sar="1:1" />
		</AdaptationSet>
		<AdaptationSet id="1" contentType="audio" startWithSAP="1" segmentAlignment="true" bitstreamSwitching="true">
			<Representation id="2" mimeType="audio/mp4" codecs="mp4a.40.2" bandwidth="192000" audioSamplingRate="48000" />
		</AdaptationSet>
	</Period>
</MPD>
`

export const blueskyActors = {
  actors: [
    {
      did: 'did:plc:exampleofficial0000000001',
      handle: 'examplestream.bsky.social',
      displayName: 'Example Stream',
      avatar: 'https://cdn.bsky.app/img/avatar/plain/did:plc:exampleofficial0000000001/bafkreiavatar@jpeg',
      verification: { verifications: [], verifiedStatus: 'valid', trustedVerifierStatus: 'none' },
      labels: []
    },
    { did: 'did:plc:examplefan0000000000000002', handle: 'fan.example.com', displayName: 'A fan', labels: [] }
  ]
}

export const blueskyFeed = {
  feed: [
    {
      post: {
        uri: 'at://did:plc:exampleofficial0000000001/app.bsky.feed.post/3kexample001',
        cid: 'bafyreiexample1',
        author: { did: 'did:plc:exampleofficial0000000001', handle: 'examplestream.bsky.social', displayName: 'Example Stream', labels: [] },
        record: { $type: 'app.bsky.feed.post', createdAt: '2026-10-01T12:00:00.000Z', text: 'Our monthly prices change next month. Here is what is new.', langs: ['en'] },
        embed: {
          $type: 'app.bsky.embed.images#view',
          images: [
            {
              thumb: 'https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:exampleofficial0000000001/bafkreiimage@jpeg',
              fullsize: 'https://cdn.bsky.app/img/feed_fullsize/plain/did:plc:exampleofficial0000000001/bafkreiimage@jpeg',
              alt: 'A price table',
              aspectRatio: { width: 1200, height: 800 }
            }
          ]
        },
        replyCount: 40,
        repostCount: 120,
        likeCount: 900,
        indexedAt: '2026-10-01T12:00:01.000Z',
        labels: []
      }
    },
    {
      post: {
        uri: 'at://did:plc:exampleofficial0000000001/app.bsky.feed.post/3kexample002',
        author: { did: 'did:plc:exampleofficial0000000001', handle: 'examplestream.bsky.social', displayName: 'Example Stream' },
        record: { text: 'A new season starts on Friday.', createdAt: '2026-09-01T12:00:00.000Z' },
        likeCount: 10,
        labels: []
      }
    },
    {
      post: {
        uri: 'at://did:plc:exampleofficial0000000001/app.bsky.feed.post/3kexample003',
        author: { did: 'did:plc:exampleofficial0000000001', handle: 'examplestream.bsky.social' },
        record: { text: 'Prices for the adult tier', createdAt: '2026-09-02T12:00:00.000Z' },
        labels: [{ val: 'porn' }]
      }
    }
  ],
  cursor: '2026-09-01T12:00:00.000Z'
}

export const pexelsPhotos = {
  total_results: 2,
  page: 1,
  per_page: 15,
  photos: [
    {
      id: 1000101,
      width: 6000,
      height: 4000,
      url: 'https://www.pexels.com/photo/hands-typing-on-a-laptop-keyboard-1000101/',
      photographer: 'Example Photographer',
      photographer_url: 'https://www.pexels.com/@example-photographer',
      photographer_id: 501,
      avg_color: '#7E7E7E',
      src: {
        original: 'https://images.pexels.com/photos/1000101/pexels-photo-1000101.jpeg',
        large2x: 'https://images.pexels.com/photos/1000101/pexels-photo-1000101.jpeg?auto=compress&cs=tinysrgb&dpr=2&h=650&w=940',
        large: 'https://images.pexels.com/photos/1000101/pexels-photo-1000101.jpeg?auto=compress&cs=tinysrgb&h=650&w=940',
        medium: 'https://images.pexels.com/photos/1000101/pexels-photo-1000101.jpeg?auto=compress&cs=tinysrgb&h=350',
        small: 'https://images.pexels.com/photos/1000101/pexels-photo-1000101.jpeg?auto=compress&cs=tinysrgb&h=130',
        portrait: 'https://images.pexels.com/photos/1000101/pexels-photo-1000101.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1200&w=800',
        landscape: 'https://images.pexels.com/photos/1000101/pexels-photo-1000101.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=627&w=1200',
        tiny: 'https://images.pexels.com/photos/1000101/pexels-photo-1000101.jpeg?auto=compress&cs=tinysrgb&dpr=1&fit=crop&h=200&w=280'
      },
      liked: false,
      alt: 'Hands typing on a laptop keyboard'
    }
  ],
  next_page: 'https://api.pexels.com/v1/search/?page=2&per_page=15&query=laptop+keyboard'
}

export const pexelsVideos = {
  page: 1,
  per_page: 15,
  total_results: 1,
  url: 'https://www.pexels.com/search/videos/laptop%20keyboard/',
  videos: [
    {
      id: 2000202,
      width: 3840,
      height: 2160,
      url: 'https://www.pexels.com/video/typing-on-a-backlit-keyboard-2000202/',
      image: 'https://images.pexels.com/videos/2000202/free-video-2000202.jpg?auto=compress&cs=tinysrgb&fit=crop&h=630&w=1200',
      duration: 14,
      user: { id: 601, name: 'Example Filmmaker', url: 'https://www.pexels.com/@example-filmmaker' },
      video_files: [
        { id: 1, quality: 'uhd', file_type: 'video/mp4', width: 3840, height: 2160, fps: 25, link: 'https://videos.pexels.com/video-files/2000202/2000202-uhd_3840_2160_25fps.mp4' },
        { id: 2, quality: 'hd', file_type: 'video/mp4', width: 1920, height: 1080, fps: 25, link: 'https://videos.pexels.com/video-files/2000202/2000202-hd_1920_1080_25fps.mp4' },
        { id: 3, quality: 'sd', file_type: 'video/mp4', width: 960, height: 540, fps: 25, link: 'https://videos.pexels.com/video-files/2000202/2000202-sd_960_540_25fps.mp4' }
      ],
      video_pictures: [{ id: 11, picture: 'https://images.pexels.com/videos/2000202/pictures/preview-0.jpg', nr: 0 }]
    }
  ]
}

export const pixabayImages = {
  total: 4692,
  totalHits: 500,
  hits: [
    {
      id: 195893,
      pageURL: 'https://pixabay.com/photos/keyboard-laptop-typing-195893/',
      type: 'photo',
      tags: 'keyboard, laptop, typing',
      previewURL: 'https://cdn.pixabay.com/photo/2013/10/15/09/12/keyboard-195893_150.jpg',
      previewWidth: 150,
      previewHeight: 84,
      webformatURL: 'https://pixabay.com/get/35bbf209e13e39d2_640.jpg',
      webformatWidth: 640,
      webformatHeight: 360,
      largeImageURL: 'https://pixabay.com/get/ed6a99fd0a76647_1280.jpg',
      imageWidth: 4000,
      imageHeight: 2250,
      imageSize: 4731420,
      views: 7671,
      downloads: 6439,
      collections: 1,
      likes: 5,
      comments: 2,
      user_id: 48777,
      user: 'Example_User',
      userImageURL: 'https://cdn.pixabay.com/user/2013/11/05/02-10-23-764_250x250.jpg'
    }
  ]
}

export const pixabayVideos = {
  total: 42,
  totalHits: 42,
  hits: [
    {
      id: 125,
      pageURL: 'https://pixabay.com/videos/id-125/',
      type: 'film',
      tags: 'keyboard, typing, office',
      duration: 12,
      videos: {
        large: { url: 'https://cdn.pixabay.com/video/2015/08/08/125-135736646_large.mp4', width: 3840, height: 2160, size: 26800000, thumbnail: 'https://cdn.pixabay.com/video/2015/08/08/125-135736646_large.jpg' },
        medium: { url: 'https://cdn.pixabay.com/video/2015/08/08/125-135736646_medium.mp4', width: 1920, height: 1080, size: 6615235, thumbnail: 'https://cdn.pixabay.com/video/2015/08/08/125-135736646_medium.jpg' },
        small: { url: 'https://cdn.pixabay.com/video/2015/08/08/125-135736646_small.mp4', width: 1280, height: 720, size: 3562083, thumbnail: 'https://cdn.pixabay.com/video/2015/08/08/125-135736646_small.jpg' },
        tiny: { url: '', width: 0, height: 0, size: 0, thumbnail: '' }
      },
      views: 4462,
      downloads: 1464,
      likes: 18,
      comments: 0,
      user_id: 1281706,
      user: 'Example_Filmmaker',
      userImageURL: ''
    }
  ]
}

export const unsplashSearch = {
  total: 133,
  total_pages: 7,
  results: [
    {
      id: 'eOLpJytrbsQ',
      created_at: '2014-11-18T14:35:36-05:00',
      width: 4000,
      height: 3000,
      color: '#A7A2A1',
      blur_hash: 'LaLXMa9Fx[D%~q%MtQM|kDRjtRIU',
      likes: 286,
      liked_by_user: false,
      description: 'A laptop keyboard at night',
      alt_description: 'black laptop keyboard',
      user: {
        id: 'Ul0QVz12Goo',
        username: 'example',
        name: 'Example Person',
        links: { self: 'https://api.unsplash.com/users/example', html: 'https://unsplash.com/@example', photos: '', likes: '' }
      },
      urls: {
        raw: 'https://images.unsplash.com/photo-1416339306562-f3d12fefd36f?ixid=example',
        full: 'https://images.unsplash.com/photo-1416339306562-f3d12fefd36f?q=85&fm=jpg&ixid=example',
        regular: 'https://images.unsplash.com/photo-1416339306562-f3d12fefd36f?w=1080&ixid=example',
        small: 'https://images.unsplash.com/photo-1416339306562-f3d12fefd36f?w=400&ixid=example',
        thumb: 'https://images.unsplash.com/photo-1416339306562-f3d12fefd36f?w=200&ixid=example'
      },
      links: {
        self: 'https://api.unsplash.com/photos/eOLpJytrbsQ',
        html: 'https://unsplash.com/photos/eOLpJytrbsQ',
        download: 'https://unsplash.com/photos/eOLpJytrbsQ/download',
        download_location: 'https://api.unsplash.com/photos/eOLpJytrbsQ/download?ixid=example'
      }
    }
  ]
}

export const giphySearch = {
  data: [
    {
      type: 'gif',
      id: 'xT9IgG50Fb7Mi0prBC',
      url: 'https://giphy.com/gifs/reaction-shrug-xT9IgG50Fb7Mi0prBC',
      slug: 'reaction-shrug-xT9IgG50Fb7Mi0prBC',
      bitly_url: 'https://gph.is/example',
      embed_url: 'https://giphy.com/embed/xT9IgG50Fb7Mi0prBC',
      username: 'examplestudio',
      source: '',
      title: 'Shrug GIF by Example Studio',
      rating: 'g',
      import_datetime: '2016-01-01 00:00:00',
      user: { username: 'examplestudio', display_name: 'Example Studio', profile_url: 'https://giphy.com/examplestudio/' },
      images: {
        original: {
          height: '270',
          width: '480',
          size: '1500000',
          url: 'https://media.giphy.com/media/xT9IgG50Fb7Mi0prBC/giphy.gif',
          mp4_size: '120000',
          mp4: 'https://media.giphy.com/media/xT9IgG50Fb7Mi0prBC/giphy.mp4',
          webp_size: '300000',
          webp: 'https://media.giphy.com/media/xT9IgG50Fb7Mi0prBC/giphy.webp',
          frames: '30',
          hash: 'abc'
        },
        fixed_height_still: { height: '200', width: '356', size: '10000', url: 'https://media.giphy.com/media/xT9IgG50Fb7Mi0prBC/200_s.gif' }
      },
      alt_text: 'A person shrugs'
    }
  ],
  pagination: { total_count: 1, count: 1, offset: 0 },
  meta: { status: 200, msg: 'OK', response_id: 'example' }
}

export const freesoundSearch = {
  count: 3,
  next: null,
  previous: null,
  results: [
    {
      id: 100001,
      name: 'keyboard click.wav',
      tags: ['keyboard', 'click', 'typing'],
      username: 'example_recordist',
      license: 'http://creativecommons.org/publicdomain/zero/1.0/',
      duration: 0.42,
      url: 'https://freesound.org/people/example_recordist/sounds/100001/',
      description: 'One key of a laptop keyboard.',
      previews: {
        'preview-hq-mp3': 'https://cdn.freesound.org/previews/100/100001_1-hq.mp3',
        'preview-hq-ogg': 'https://cdn.freesound.org/previews/100/100001_1-hq.ogg',
        'preview-lq-mp3': 'https://cdn.freesound.org/previews/100/100001_1-lq.mp3',
        'preview-lq-ogg': 'https://cdn.freesound.org/previews/100/100001_1-lq.ogg'
      },
      avg_rating: 4.2,
      num_downloads: 1200
    },
    {
      id: 100002,
      name: 'typing burst',
      tags: ['typing'],
      username: 'another_recordist',
      license: 'https://creativecommons.org/licenses/by/4.0/',
      duration: 3.1,
      url: 'https://freesound.org/people/another_recordist/sounds/100002/',
      previews: { 'preview-hq-mp3': 'https://cdn.freesound.org/previews/100/100002_2-hq.mp3' }
    },
    {
      id: 100003,
      name: 'typing for fun',
      tags: ['typing'],
      username: 'nc_recordist',
      license: 'http://creativecommons.org/licenses/by-nc/3.0/',
      duration: 5,
      url: 'https://freesound.org/people/nc_recordist/sounds/100003/',
      previews: { 'preview-hq-mp3': 'https://cdn.freesound.org/previews/100/100003_3-hq.mp3' }
    }
  ]
}

/** A Messages API answer with the web_search tool's documented blocks: a server_tool_use, its result, and the text. */
export const claudeWebAnswer = (stop: 'end_turn' | 'pause_turn' = 'end_turn'): Record<string, unknown> => ({
  id: 'msg_example',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  stop_reason: stop,
  stop_sequence: null,
  usage: { input_tokens: 6200, output_tokens: 420, server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } },
  content: [
    { type: 'server_tool_use', id: 'srvtoolu_01', name: 'web_search', input: { query: 'streaming service raises prices' } },
    {
      type: 'web_search_tool_result',
      tool_use_id: 'srvtoolu_01',
      content: [
        { type: 'web_search_result', url: 'https://news.example.com/2026/10/streaming-prices', title: 'A streaming service raises its prices', page_age: 'October 1, 2026', encrypted_content: 'EqgfCioIARgBIiQ3YTAwMjY1Mi1' },
        { type: 'web_search_result', url: 'https://about.example-stream.com/newsroom/pricing', title: 'Our new plans', page_age: 'September 30, 2026', encrypted_content: 'EqgfCioIARgBIiQ3YTAwMjY1Mi2' },
        { type: 'web_search_result', url: 'https://blog.example.org/opinion', title: 'What the price change means', page_age: null, encrypted_content: 'EqgfCioIARgBIiQ3YTAwMjY1Mi3' }
      ]
    },
    ...(stop === 'end_turn'
      ? [
          {
            type: 'text',
            text:
              '[{"url": "https://about.example-stream.com/newsroom/pricing", "title": "Our new plans", "publisher": "Example Stream", "kind": "newsroom", "why": "The company’s own announcement."},' +
              ' {"url": "https://news.example.com/2026/10/streaming-prices", "title": "A streaming service raises its prices", "publisher": "Example News", "kind": "article", "why": "The report."},' +
              ' {"url": "https://made-up.example.net/not-in-results", "title": "Invented", "publisher": "Nobody", "kind": "article", "why": "Not from the search."}]'
          }
        ]
      : [])
  ]
})

/** yt-dlp's flat-playlist JSON for a search, with each video's channel, as yt-dlp prints it. */
export const ytdlpSearch = (entries: { id: string; title: string; duration: number; channel: string; handle: string; channelId: string }[]): Record<string, unknown> => ({
  _type: 'playlist',
  id: 'search',
  title: 'search',
  entries: entries.map((e) => ({
    _type: 'url',
    ie_key: 'Youtube',
    id: e.id,
    url: `https://www.youtube.com/watch?v=${e.id}`,
    title: e.title,
    duration: e.duration,
    channel: e.channel,
    channel_id: e.channelId,
    channel_url: `https://www.youtube.com/channel/${e.channelId}`,
    uploader: e.channel,
    uploader_id: e.handle,
    uploader_url: `https://www.youtube.com/${e.handle}`
  }))
})
