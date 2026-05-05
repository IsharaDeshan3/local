import { readFileSync } from 'fs';
import { join } from 'path';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(
  request: NextRequest,
  { params }: { params: { image: string } }
) {
  try {
    const imageName = params.image;
    
    // Security: prevent directory traversal
    if (imageName.includes('..') || imageName.includes('/')) {
      return NextResponse.json({ error: 'Invalid image name' }, { status: 400 });
    }
    
    const imagePath = join(process.cwd(), 'images', imageName);
    const imageBuffer = readFileSync(imagePath);
    
    // Determine content type based on file extension
    const ext = imageName.toLowerCase().split('.').pop();
    let contentType = 'image/jpeg';
    if (ext === 'png') contentType = 'image/png';
    else if (ext === 'gif') contentType = 'image/gif';
    else if (ext === 'webp') contentType = 'image/webp';
    
    return new NextResponse(imageBuffer, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (error) {
    console.error('Image serving error:', error);
    return NextResponse.json({ error: 'Image not found' }, { status: 404 });
  }
}
