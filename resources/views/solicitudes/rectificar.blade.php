@extends(config('arcop-panel.layout'))

@section('arcop-titulo', 'Rectificar los datos del titular')

@section('arcop')
    @include('arcop-panel::partes.avisos')

    <p><a href="{{ route('arcop.solicitudes.show', $solicitud) }}">&larr; Volver a la solicitud</a></p>

    <h1>Rectificar y acoger</h1>

    @if ($advertencia)
        <p class="arcop-aviso arcop-aviso--atencion" role="note">{{ $advertencia }}</p>
    @endif

    <p class="arcop-guia">Dejá igual lo que esté bien: se envía únicamente lo que cambies. Qué campos son
        rectificables lo declara el propio registro, no esta pantalla.</p>

    <form method="POST" action="{{ route('arcop.solicitudes.rectificar.aplicar', $solicitud) }}" class="arcop-formulario">
        @csrf

        @foreach ($campos as $campo)
            <div class="arcop-campo">
                <label for="valor-{{ $campo }}">{{ \Illuminate\Support\Str::headline($campo) }}</label>
                <input id="valor-{{ $campo }}" name="valores[{{ $campo }}]" type="text" maxlength="255"
                       value="{{ old('valores.'.$campo, $titular?->getAttribute($campo)) }}">
            </div>
        @endforeach

        <div class="arcop-campo">
            <label for="fundamento">Fundamento de la resolución</label>
            <textarea id="fundamento" name="fundamento" rows="4" required>{{ old('fundamento') }}</textarea>
        </div>

        <button class="arcop-boton arcop-boton--principal" type="submit">Rectificar y acoger</button>
    </form>
@endsection
